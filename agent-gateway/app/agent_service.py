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
    StreamEvent as SDKStreamEvent,
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
    "mcp__opencut__get_preview_sequence",
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
    # SDK 消息流由常驻消息泵消费后写入此队列，轮次从队列取消息。
    # 好处：客户端断流后消息泵继续消费，残留消息在下一轮开始前被丢弃，
    # 不会像直接迭代 receive_response() 那样被下一轮误当成自己的结果。
    messages: asyncio.Queue = field(default_factory=asyncio.Queue)
    pump_task: asyncio.Task | None = None

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
        settings_path = config_dir / "settings.json"
        if not settings_path.exists():
            settings_path.write_text(
                json.dumps({"hasCompletedOnboarding": True}, ensure_ascii=False, indent=2)
                + "\n",
                encoding="utf-8",
            )

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
            # 增量流式：CLI 推送 stream_event（thinking/text delta），
            # 前端可实时显示"思考中"与逐字输出，而不是等整条消息生成完
            include_partial_messages=True,
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

        # 启动常驻消息泵：唯一消费者，断流后仍持续消费 SDK 消息流
        state.pump_task = asyncio.create_task(self._message_pump(session_id))

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
            # 增量流式状态：saw_delta 标记本轮是否收到过增量事件
            # （用于跳过完整消息里的文本块，避免与增量重复输出）
            saw_delta = False
            thinking_status_sent = False
            try:
                # 丢弃上一轮残留（断流后消息泵仍在消费，队列里可能留有旧消息）
                dropped = await self._discard_pending_messages(state)
                if dropped:
                    logger.info(f"[Agent] [{session_id[:8]}] 丢弃上一轮残留消息: {dropped} 条")

                await state.client.query(message)

                cost_usd = 0.0
                while True:
                    msg = await state.messages.get()
                    if msg is None:
                        # 消息泵已退出（CLI 进程结束/连接断开）
                        logger.warning(
                            f"[Agent] [{session_id[:8]}] 消息泵已退出，本轮提前结束"
                        )
                        state.is_active = False
                        yield StreamEvent(
                            event="error",
                            data={"error": "Agent 连接已断开，请重试", "recoverable": True},
                        )
                        break
                    if isinstance(msg, SDKStreamEvent):
                        event = msg.event or {}
                        event_type = event.get("type")
                        if event_type == "content_block_start":
                            block = event.get("content_block") or {}
                            if block.get("type") == "thinking":
                                thinking_status_sent = False
                        elif event_type == "content_block_delta":
                            delta = event.get("delta") or {}
                            delta_type = delta.get("type")
                            if delta_type == "text_delta":
                                text = delta.get("text") or ""
                                if text:
                                    saw_delta = True
                                    yield StreamEvent(event="text", data={"text": text})
                            elif delta_type == "thinking_delta":
                                saw_delta = True
                                # 每个 thinking 块只推一次状态事件，避免刷屏
                                if not thinking_status_sent:
                                    thinking_status_sent = True
                                    yield StreamEvent(
                                        event="thinking", data={"thinking": "思考中"}
                                    )
                    elif isinstance(msg, AssistantMessage):
                        for block in msg.content:
                            if isinstance(block, TextBlock):
                                if saw_delta:
                                    continue  # 已按增量推送过，跳过完整消息避免重复
                                yield StreamEvent(event="text", data={"text": block.text})
                            elif isinstance(block, ThinkingBlock):
                                if saw_delta:
                                    continue
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
                            # 错误必须推给前端：否则本轮会静默结束（无回复也无提示）
                            detail = str(msg.result or msg.subtype or "未知错误").strip()
                            if len(detail) > 300:
                                detail = detail[:300] + "..."
                            yield StreamEvent(
                                event="error",
                                data={
                                    "error": f"Agent 执行出错: {detail}",
                                    "recoverable": True,
                                },
                            )
                        break  # 本轮结束

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

    # ------------------------------------------------------------------
    # 消息泵 / 残留清理（防止上一轮结果污染下一轮）
    # ------------------------------------------------------------------

    async def _message_pump(self, session_id: str) -> None:
        """常驻消费 SDK 消息流并写入会话队列（每个 session 唯一的消费者）。

        客户端断流后仍继续消费：本轮剩余消息会堆积在队列里，
        由下一轮开始前的 _discard_pending_messages 统一丢弃。
        """
        state = self._sessions.get(session_id)
        if not state or not state.client:
            return
        try:
            async for msg in state.client.receive_messages():
                await state.messages.put(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"[Agent] [{session_id[:8]}] 消息泵退出: {type(e).__name__}: {e}")
        finally:
            state.pump_task = None
            try:
                state.messages.put_nowait(None)  # 唤醒等待中的消费者
            except Exception:
                pass

    async def _discard_pending_messages(self, state: _SessionState) -> int:
        """丢弃上一轮残留消息。

        - 队列为空：短暂探测后返回 0（正常无残留的快速路径）
        - 有残留：丢弃到上一轮的 ResultMessage 为止，确保上一轮彻底结束；
          上一轮迟迟不结束时主动 interrupt，避免新轮次被旧消息污染
        """
        dropped = 0
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 20.0
        interrupted = False
        while True:
            if dropped == 0:
                try:
                    msg = await asyncio.wait_for(state.messages.get(), timeout=0.3)
                except TimeoutError:
                    return 0
            else:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    logger.warning(
                        f"[Agent] [{state.session_id[:8]}] 残留消息清理超时，可能有旧消息混入本轮"
                    )
                    return dropped
                try:
                    msg = await asyncio.wait_for(
                        state.messages.get(), timeout=min(remaining, 1.0)
                    )
                except TimeoutError:
                    # 上一轮迟迟不结束：主动打断一次（用户已发新消息，旧轮次已无人接收）
                    if not interrupted and state.client:
                        interrupted = True
                        try:
                            await state.client.interrupt()
                        except Exception:
                            pass
                    continue
            dropped += 1
            if msg is None:
                return dropped  # 消息泵已退出，无需继续等待
            if isinstance(msg, ResultMessage):
                return dropped

    async def close_session(self, session_id: str) -> None:
        state = self._sessions.pop(session_id, None)
        if not state:
            return
        if state.pump_task:
            state.pump_task.cancel()
            try:
                await state.pump_task
            except (asyncio.CancelledError, Exception):
                pass
            state.pump_task = None
        if state.client:
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
            if state.is_active
            and not state.lock.locked()  # 正在进行一轮对话，不能清理
            and now - state.last_activity >= max_idle_seconds
        ]
        for sid in idle:
            logger.info(f"[Agent] 清理空闲 session: {sid[:8]}")
            await self.close_session(sid)
        return len(idle)


agent_service = AgentService()
