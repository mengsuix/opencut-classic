"""Agent 会话服务 - 基于 claude-agent-sdk ClaudeSDKClient

模式移植自 infer-web 的 ModalEditorService：
- 每 session 一个常驻 Claude CLI 子进程（_sessions 内存字典）
- lock 串行化同一 session 的 turn
- 空闲清理 + 中断支持
- 差异：工具面只有编辑器 MCP 工具（无文件系统/Bash），无权限回调
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)
from claude_agent_sdk._errors import (
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ProcessError,
)

from . import config
from .editor_bridge import build_editor_mcp_server
from .system_prompt import EDITOR_SYSTEM_PROMPT

logger = logging.getLogger("agent-gateway.agent")

OPENCUT_MCP_TOOLS = [
    "mcp__opencut__editor_status",
    "mcp__opencut__list_commands",
    "mcp__opencut__get_editor_state",
    "mcp__opencut__get_selection",
    "mcp__opencut__execute_command",
    "mcp__opencut__get_preview_frame",
]


@dataclass
class StreamEvent:
    event: str
    data: dict

    def to_sse(self) -> str:
        return f"event: {self.event}\ndata: {json.dumps(self.data, ensure_ascii=False)}\n\n"


@dataclass
class SessionInfo:
    session_id: str
    project_id: str
    user_id: str
    created_at: float
    turn_count: int = 0
    total_cost_usd: float = 0.0
    is_active: bool = True


@dataclass
class _SessionState:
    session_id: str
    project_id: str
    user_id: str
    created_at: float
    turn_count: int = 0
    total_cost_usd: float = 0.0
    is_active: bool = True
    client: ClaudeSDKClient | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_activity: float = 0.0
    interrupted: bool = False

    def __post_init__(self):
        if self.last_activity == 0.0:
            self.last_activity = self.created_at or time.time()

    def to_info(self) -> SessionInfo:
        return SessionInfo(
            session_id=self.session_id,
            project_id=self.project_id,
            user_id=self.user_id,
            created_at=self.created_at,
            turn_count=self.turn_count,
            total_cost_usd=self.total_cost_usd,
            is_active=self.is_active,
        )


class AgentService:
    """OpenCut 编辑器 Agent 多轮对话服务"""

    def __init__(self):
        self._sessions: dict[str, _SessionState] = {}

    async def create_session(
        self,
        *,
        session_id: str,
        project_id: str,
        user_id: str,
        resume: bool = False,
    ) -> str:
        """创建（或恢复）一个 Agent session，启动常驻 Claude CLI 子进程"""
        existing = self._sessions.get(session_id)
        if existing and existing.is_active:
            return session_id

        data_dir = config.AGENT_DATA_DIR / session_id
        config_dir = data_dir / "claude-config"
        config_dir.mkdir(parents=True, exist_ok=True)

        agent_env = dict(config.AGENT_ENV)
        # CLI 会话数据落盘位置固定，Gateway 重启后 resume 才能找回上下文
        agent_env["CLAUDE_CONFIG_DIR"] = str(config_dir)

        options = ClaudeAgentOptions(
            system_prompt=EDITOR_SYSTEM_PROMPT,
            cwd=str(data_dir),
            model=config.AGENT_MODEL,
            tools=OPENCUT_MCP_TOOLS,
            mcp_servers={"opencut": build_editor_mcp_server(session_id)},
            env=agent_env,
            # 服务端自动化场景无确认通道，工具面已由 tools 限定为编辑器 MCP 工具
            permission_mode="bypassPermissions",
            resume=session_id if resume else None,
            session_id=session_id if not resume else None,
            stderr=lambda line: logger.error(f"[Agent STDERR] {line}"),
            # 工具结果（截图/大型工程状态）可能超过默认 1MB 的 JSON 消息缓冲
            max_buffer_size=8 * 1024 * 1024,
        )
        client = ClaudeSDKClient(options=options)

        state = _SessionState(
            session_id=session_id,
            project_id=project_id,
            user_id=user_id,
            created_at=time.time(),
            client=client,
        )
        self._sessions[session_id] = state

        try:
            await client.connect()
        except (CLINotFoundError, ProcessError, CLIConnectionError, CLIJSONDecodeError) as e:
            self._sessions.pop(session_id, None)
            logger.error(f"[Agent] 创建 session 失败: {type(e).__name__}: {e}")
            raise RuntimeError(f"创建 Agent 会话失败: {e}") from e
        except Exception as e:
            self._sessions.pop(session_id, None)
            logger.error(f"[Agent] 创建 session 未知异常: {type(e).__name__}: {e}")
            raise

        logger.info(
            f"[Agent] Session 已创建: {session_id[:8]}, project={project_id}, resume={resume}"
        )
        return session_id

    async def send_message_stream(
        self, session_id: str, message: str
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        事件类型：
        - text: 文本片段 {"text": "..."}
        - thinking: 思考过程 {"thinking": "..."}
        - tool_use: 工具调用 {"tool": "execute_command", "summary": "timeline.split_elements"}
        - result: 完成 {"cost_usd": ..., "turn_number": ..., "interrupted": bool}
        - error: 错误 {"error": "...", "recoverable": bool?}
        """
        state = self._sessions.get(session_id)
        if not state:
            yield StreamEvent(event="error", data={"error": f"Session 不存在: {session_id}"})
            return
        if not state.is_active:
            try:
                await self.create_session(
                    session_id=state.session_id,
                    project_id=state.project_id,
                    user_id=state.user_id,
                    resume=True,
                )
                state = self._sessions[session_id]
            except Exception as e:
                yield StreamEvent(event="error", data={"error": f"Session 无法恢复: {e}"})
                return
        if not state.client:
            yield StreamEvent(event="error", data={"error": f"Session 未初始化: {session_id}"})
            return

        if state.turn_count >= config.MAX_TURNS_PER_SESSION:
            yield StreamEvent(
                event="error",
                data={
                    "error": f"已达到最大对话轮次 ({config.MAX_TURNS_PER_SESSION})，请新建对话",
                    "max_turns_reached": True,
                    "turn_number": state.turn_count,
                },
            )
            return

        async with state.lock:
            interrupted = False
            state.interrupted = False
            try:
                await state.client.query(message)

                cost_usd = 0.0
                async for msg in state.client.receive_response():
                    if isinstance(msg, AssistantMessage):
                        for block in msg.content:
                            if isinstance(block, TextBlock):
                                yield StreamEvent(event="text", data={"text": block.text})
                            elif isinstance(block, ThinkingBlock):
                                yield StreamEvent(
                                    event="thinking",
                                    data={"thinking": block.thinking[:200]},
                                )
                            elif isinstance(block, ToolUseBlock):
                                short_name = block.name.split("__")[-1]
                                summary = ""
                                if short_name == "execute_command":
                                    summary = str(block.input.get("command") or "")
                                elif short_name == "get_preview_frame":
                                    t = block.input.get("time")
                                    if isinstance(t, (int, float)):
                                        summary = f"{t}s"
                                logger.info(
                                    f"[Agent] [{session_id[:8]}] 工具调用: {short_name} {summary}"
                                )
                                yield StreamEvent(
                                    event="tool_use",
                                    data={"tool": short_name, "summary": summary},
                                )
                    elif isinstance(msg, ResultMessage):
                        cost_usd = msg.total_cost_usd or 0.0
                        if (
                            state.interrupted
                            or (msg.stop_reason or "").lower() == "interrupted"
                            or "interrupt" in (msg.result or "").lower()
                        ):
                            interrupted = True
                        if msg.is_error and not interrupted:
                            logger.error(
                                f"[Agent] [{session_id[:8]}] 返回错误: subtype={msg.subtype}, result={msg.result}"
                            )

                state.turn_count += 1
                state.total_cost_usd += cost_usd
                state.last_activity = time.time()

                yield StreamEvent(
                    event="result",
                    data={
                        "cost_usd": cost_usd,
                        "turn_number": state.turn_count,
                        "max_turns_reached": state.turn_count >= config.MAX_TURNS_PER_SESSION,
                        "interrupted": interrupted,
                    },
                )

            except (CLINotFoundError, CLIJSONDecodeError) as e:
                state.is_active = False
                yield StreamEvent(event="error", data={"error": f"{type(e).__name__}: {e}"})
            except ProcessError as e:
                logger.error(f"[Agent] [{session_id[:8]}] 进程异常退出: exit_code={e.exit_code}")
                state.is_active = False
                state.client = None
                yield StreamEvent(
                    event="error",
                    data={"error": "Agent 进程异常退出，请重试", "recoverable": True},
                )
            except CLIConnectionError as e:
                logger.error(f"[Agent] [{session_id[:8]}] 连接断开: {e}")
                state.is_active = False
                state.client = None
                yield StreamEvent(
                    event="error",
                    data={"error": "Agent 连接断开，请重试", "recoverable": True},
                )
            except Exception as e:
                logger.error(f"[Agent] [{session_id[:8]}] 未知异常: {type(e).__name__}: {e}")
                yield StreamEvent(event="error", data={"error": f"{type(e).__name__}: {e}"})

    async def close_session(self, session_id: str) -> None:
        state = self._sessions.pop(session_id, None)
        if state and state.client:
            try:
                await state.client.disconnect()
            except Exception as e:
                logger.warning(f"[Agent] 断开 client 失败: {session_id[:8]}, {e}")

    async def interrupt_session(self, session_id: str) -> bool:
        """不获取 lock（send_message_stream 正持有），直接向 CLI 发 interrupt"""
        state = self._sessions.get(session_id)
        if not state or not state.is_active or not state.client:
            return False
        try:
            await state.client.interrupt()
            state.interrupted = True
            return True
        except Exception as e:
            logger.error(f"[Agent] [{session_id[:8]}] interrupt 失败: {e}")
            return False

    def get_session_info(self, session_id: str) -> SessionInfo | None:
        state = self._sessions.get(session_id)
        return state.to_info() if state else None

    async def close_all_sessions(self) -> None:
        for sid in list(self._sessions.keys()):
            await self.close_session(sid)

    async def cleanup_idle_sessions(self, max_idle_seconds: float) -> int:
        now = time.time()
        idle = [
            sid
            for sid, state in self._sessions.items()
            if state.is_active and now - state.last_activity >= max_idle_seconds
        ]
        for sid in idle:
            logger.info(f"[Agent] 清理空闲 session: {sid[:8]}")
            await self.close_session(sid)
        return len(idle)


agent_service = AgentService()
