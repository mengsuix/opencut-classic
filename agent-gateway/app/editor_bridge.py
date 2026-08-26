"""编辑器桥：浏览器 WS 连接注册表 + in-process MCP 工具

架构：
    Claude SDK 子进程 --(in-process MCP)--> 本模块 tool handler
        --> call_editor(session_id, ...) --(WS)--> 浏览器 BRIDGE_COMMANDS

WS 协议与 packages/mcp-server 保持一致（hello / request / response），
浏览器侧 bridge client 无需改协议，只换连接地址。
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable

from fastapi import WebSocket, WebSocketDisconnect
from claude_agent_sdk import create_sdk_mcp_server, tool

from . import auth, db

logger = logging.getLogger("agent-gateway.bridge")

DEFAULT_TIMEOUT_SECONDS = 120
COMMAND_TIMEOUTS: dict[str, float] = {
    "subtitles.transcribe": 900,
    "media.import": 600,
    "export.start": 1800,
}

# session_id -> 浏览器编辑器 WS
_editor_sockets: dict[str, WebSocket] = {}
# session_id -> hello 信息（projectId / projectName）
_editor_info: dict[str, dict] = {}
# request_id -> (future, timer, session_id)
_pending: dict[str, tuple[asyncio.Future, asyncio.TimerHandle, str]] = {}
_request_seq = 0


class EditorNotConnectedError(RuntimeError):
    pass


async def call_editor(
    session_id: str, command: str, args: dict | None = None, timeout: float | None = None
):
    """向指定 session 对应的浏览器编辑器下发命令并等待结果"""
    ws = _editor_sockets.get(session_id)
    if ws is None:
        raise EditorNotConnectedError(
            "编辑器页面未连接。请在浏览器中打开该项目的编辑器，并打开 AI 面板。"
        )
    global _request_seq
    _request_seq += 1
    request_id = f"req-{_request_seq}"
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()

    def on_timeout() -> None:
        entry = _pending.pop(request_id, None)
        if entry and not entry[0].done():
            entry[0].set_exception(TimeoutError(f"编辑器命令超时: {command}"))

    timer = loop.call_later(
        timeout or COMMAND_TIMEOUTS.get(command, DEFAULT_TIMEOUT_SECONDS), on_timeout
    )
    _pending[request_id] = (fut, timer, session_id)
    await ws.send_json(
        {"type": "request", "id": request_id, "command": command, "args": args or {}}
    )
    return await fut


def _text(value) -> dict:
    return {
        "content": [
            {"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}
        ]
    }


def _error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "is_error": True}


def build_editor_mcp_server(session_id: str):
    """为某个 session 构建 in-process MCP server（工具闭包绑定 session_id）"""

    async def run(command: str, args: dict | None = None) -> dict:
        try:
            return _text(await call_editor(session_id, command, args))
        except Exception as e:
            return _error(str(e))

    @tool(
        "editor_status",
        "Check whether an OpenCut editor page is connected to this bridge and which project is open.",
        {},
    )
    async def editor_status(args):
        return _text(
            {
                "connected": _editor_sockets.get(session_id) is not None,
                **_editor_info.get(session_id, {}),
            }
        )

    @tool(
        "list_commands",
        "List all editor commands available via execute_command, with argument hints. All time values are in seconds.",
        {},
    )
    async def list_commands(args):
        return await run("commands.list")

    @tool(
        "get_editor_state",
        "Get the current editor state: project settings, scenes, tracks and elements (times in seconds), selection, playback position, undo/redo availability, and media assets.",
        {},
    )
    async def get_editor_state(args):
        return await run("state.get")

    @tool(
        "get_selection",
        'Get the current editor selection in detail: selected timeline elements (refs, track type, element type, name, timing in seconds, text content), selected keyframes and mask points. When the user refers to "the selected part/clip/选中的部分", call this first to resolve what it refers to. Commands that accept an "elements" array also accept the string "$selection" to target the current selection directly.',
        {},
    )
    async def get_selection(args):
        return await run("selection.describe")

    @tool(
        "execute_command",
        'Execute an editor command in the open OpenCut editor. Use list_commands to discover commands. All time arguments are in seconds. Every command runs through the editor\'s command system, so changes are applied to the live preview immediately and are undoable. For commands that accept an "elements" array, you may pass the string "$selection" to target the user\'s current selection (fails if nothing is selected); use the get_selection tool to see what is selected.',
        {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Command name, e.g. timeline.split_elements",
                },
                "args": {
                    "type": "object",
                    "description": "Command arguments; see list_commands for hints",
                },
            },
            "required": ["command"],
        },
    )
    async def execute_command(args):
        command = args.get("command")
        if not isinstance(command, str) or not command:
            return _error("Missing required argument: command")
        cmd_args = args.get("args")
        if not isinstance(cmd_args, dict):
            cmd_args = {}
        return await run(command, cmd_args)

    @tool(
        "get_preview_frame",
        "Capture a frame of the current preview as a downscaled image. Optionally render at a specific time (seconds) instead of the current playhead position. Use this for visual feedback after making edits.",
        {
            "type": "object",
            "properties": {
                "time": {
                    "type": "number",
                    "description": "Time in seconds; defaults to current playhead",
                }
            },
        },
    )
    async def get_preview_frame(args):
        payload = {}
        if isinstance(args.get("time"), (int, float)):
            payload["time"] = args["time"]
        try:
            result = await call_editor(session_id, "preview.capture", payload)
        except Exception as e:
            return _error(str(e))
        data_url = (result or {}).get("dataUrl", "")
        base64_data = data_url.split(",", 1)[-1] if "," in data_url else data_url
        mime = "image/png"
        if data_url.startswith("data:") and ";" in data_url:
            mime = data_url[5 : data_url.index(";")]
        meta = {
            k: result[k] for k in ("width", "height", "time") if k in (result or {})
        }
        return {
            "content": [
                {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
                {"type": "image", "data": base64_data, "mimeType": mime},
            ]
        }

    return create_sdk_mcp_server(
        name="opencut",
        version="1.0.0",
        tools=[
            editor_status,
            list_commands,
            get_editor_state,
            get_selection,
            execute_command,
            get_preview_frame,
        ],
    )


async def editor_websocket_endpoint(websocket: WebSocket) -> None:
    """浏览器编辑器 WS 入口：/ws/editor?session_id=...&token=..."""
    session_id = websocket.query_params.get("session_id", "")
    token = websocket.query_params.get("token", "")

    try:
        user_id = await auth.resolve_user_id(token)
    except Exception:
        await websocket.close(code=4401, reason="Unauthorized")
        return

    owner = await db.fetchval(
        "SELECT user_id FROM agent_sessions WHERE session_id = $1", session_id
    )
    if owner is None or owner != user_id:
        await websocket.close(code=4403, reason="Forbidden")
        return

    # 同一会话的新连接顶替旧连接（用户在新标签页打开了编辑器）
    old = _editor_sockets.get(session_id)
    if old is not None:
        try:
            await old.close(code=1013, reason="Replaced by a newer connection")
        except Exception:
            pass

    await websocket.accept()
    _editor_sockets[session_id] = websocket
    logger.info(f"[bridge] 编辑器已连接: session={session_id[:8]}")

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except Exception:
                continue
            msg_type = message.get("type")
            if msg_type == "hello" and message.get("role") == "editor":
                _editor_info[session_id] = {
                    "projectId": message.get("projectId"),
                    "projectName": message.get("projectName"),
                }
            elif msg_type == "response":
                entry = _pending.pop(message.get("id"), None)
                if not entry:
                    continue
                fut, timer, _ = entry
                timer.cancel()
                if fut.done():
                    continue
                if message.get("ok"):
                    fut.set_result(message.get("result"))
                else:
                    fut.set_exception(
                        RuntimeError(str(message.get("error") or "Unknown editor error"))
                    )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[bridge] 连接异常: session={session_id[:8]}, error={e}")
    finally:
        if _editor_sockets.get(session_id) is websocket:
            _editor_sockets.pop(session_id, None)
            _editor_info.pop(session_id, None)
            logger.info(f"[bridge] 编辑器已断开: session={session_id[:8]}")
        for req_id, (fut, timer, sid) in list(_pending.items()):
            if sid == session_id:
                timer.cancel()
                if not fut.done():
                    fut.set_exception(EditorNotConnectedError("编辑器连接已断开"))
                _pending.pop(req_id, None)
