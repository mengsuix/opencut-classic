"""编辑器桥：浏览器 WS 连接注册表 + in-process MCP 工具

架构：
    Claude SDK 子进程 --(in-process MCP)--> 本模块 tool handler
        --> call_editor(session_id, ...) --(WS)--> 浏览器 BRIDGE_COMMANDS

WS 协议与 packages/mcp-server 保持一致（hello / request / response），
浏览器侧 bridge client 无需改协议，只换连接地址。
"""

import asyncio
import base64
import json
import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect
from claude_agent_sdk import create_sdk_mcp_server, tool

from . import auth, config, db, fx_catalog, fx_render, visual_judge
# 注：fx_render 是内部渲染模块（HyperFrames 封装），agent 侧暴露的工具名为 add_media。

logger = logging.getLogger("agent-gateway.bridge")

DEFAULT_TIMEOUT_SECONDS = 120
# 与前端 preview.capture_sequence 的 MAX_SEQUENCE_FRAMES 保持一致。
# 拼图面积决定 image token 成本，超过 24 帧后成本增长快而"看结构"的收益很低。
MAX_SEQUENCE_FRAMES = 24
# supply_media_window 窗口时长硬上限（秒）。SKILL 指导 ≤1.5s 控制烘焙帧缓存内存，
# 硬上限只防 agent 误传整段素材；与前端 registry.ts 的 MAX_SUPPLY_WINDOW_SECONDS 一致。
MAX_SUPPLY_WINDOW_SECONDS = 5
COMMAND_TIMEOUTS: dict[str, float] = {
    "subtitles.transcribe": 900,
    "media.import": 600,
    "export.start": 1800,
    # 批量抽帧逐帧离屏渲染，24 帧在复杂工程上可能超过默认 120s
    "preview.capture_sequence": 300,
    # 视频素材离线抽帧，长 GOP 的 4K 素材多次 seek 解码可能较慢
    "media.read": 300,
    # 浏览器转码窗口段 + 上传，4K 源解码转码较慢
    "media.supply_window": 300,
}

# session_id -> 浏览器编辑器 WS
_editor_sockets: dict[str, WebSocket] = {}
# session_id -> hello 信息（projectId / projectName）
_editor_info: dict[str, dict] = {}
# session_id -> 产物下载用对外 base url（从编辑器连接的 Host 头推导）
_editor_base_urls: dict[str, str] = {}
# request_id -> (future, timer, session_id)
_pending: dict[str, tuple[asyncio.Future, asyncio.TimerHandle, str]] = {}
_request_seq = 0


class EditorNotConnectedError(RuntimeError):
    pass


def _derive_base_url(websocket: WebSocket) -> str:
    """产物下载用对外地址：配置优先，否则从编辑器连接的 Host 头推导"""
    if config.FX_PUBLIC_BASE_URL:
        return config.FX_PUBLIC_BASE_URL
    host = websocket.headers.get("host", "")
    if not host:
        return ""
    scheme = (
        "https" if websocket.headers.get("x-forwarded-proto") == "https" else "http"
    )
    return f"{scheme}://{host}"


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


def _evict_oldest_unpinned(handles: dict, pinned: set, max_n: int) -> None:
    """FIFO 淘汰最旧的未固定句柄；全部固定时允许超限（参考图是评判循环的锚点，不可淘汰）"""
    while len(handles) > max_n:
        victim = next((h for h in handles if h not in pinned), None)
        if victim is None:
            return
        handles.pop(victim)


def build_editor_mcp_server(session_id: str):
    """为某个 session 构建 in-process MCP server（工具闭包绑定 session_id）"""

    # 图片句柄缓存：模型能"看"图但无法在工具参数里复述图片原文，
    # 故回传给模型的图片同时在此登记 img-N 句柄，judge_visual 等工具
    # 凭句柄取图，图片字节不再传输。
    image_handles: dict[str, tuple[str, str]] = {}  # handle -> (base64_data, mime)
    pinned_handles: set[str] = set()  # judge_visual 参考图句柄，不参与 FIFO 淘汰
    handle_seq = {"img": 0}
    MAX_IMAGE_HANDLES = 20

    def _register_image(base64_data: str, mime: str) -> str:
        handle_seq["img"] += 1
        handle = f"img-{handle_seq['img']}"
        image_handles[handle] = (base64_data, mime)
        # 新句柄一并保护：否则存量全是固定参考图时，新图会被立即淘汰
        _evict_oldest_unpinned(
            image_handles, pinned_handles | {handle}, MAX_IMAGE_HANDLES
        )
        return handle

    async def run(command: str, args: dict | None = None) -> dict:
        try:
            return _text(await call_editor(session_id, command, args))
        except Exception as e:
            return _error(str(e))

    @tool(
        "editor_status",
        "检查是否有 OpenCut 编辑器页面连接到本桥接，以及当前打开的是哪个项目。",
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
        "列出 execute_command 可用的全部编辑器命令及参数提示。所有时间值单位是秒。",
        {},
    )
    async def list_commands(args):
        return await run("commands.list")

    @tool(
        "get_editor_state",
        '获取当前编辑器状态：项目设置、场景、轨道与元素（时间单位为秒）、选中情况、播放头位置、撤销/重做可用性、素材列表。trackOrder 按界面显示顺序列出全部轨道（row 0 = 时间线界面最上面一行）；上方轨道渲染时压在下方轨道之上，effect 轨道只作用于其下方画面。用户说"第一条/最上面/最下面那条轨道"或"第几层"时，按 trackOrder 解析，不按 main/overlay/audio 的分组顺序猜。',
        {},
    )
    async def get_editor_state(args):
        return await run("state.get")

    @tool(
        "get_selection",
        '获取当前编辑器选区的详细信息：选中的时间线元素（引用、轨道类型、元素类型、名称、秒级时间、文本内容）、选中的关键帧与蒙版点。用户说"选中的部分/这段"时，先调本工具确认指代。接受 "elements" 数组的命令也可传字符串 "$selection"，直接作用于当前选中。',
        {},
    )
    async def get_selection(args):
        return await run("selection.describe")

    @tool(
        "get_user_marks",
        "获取用户用于指代位置的可视化标注：canvasRects = 用户在预览画面上框选的矩形（每个带 \"C1\"、\"C2\" 等标注 id，直接显示在框上；坐标是 0~1 画布比例、左上角原点——与 masks.set_canvas_rect 同一坐标系，可直接作它的 rect 参数；内含框选时刻的播放头秒数；把它传给 get_preview_frame 的 rect 可拿该区域的原生分辨率特写——看清图标、文字等小细节的正确方式）；timeRanges = 用户在时间轴上拖选的时间范围（每个带 \"T1\"、\"T2\" 等标注 id，显示在色带上；单位秒）。每种都可标多个，用户用标注 id 指代（如 \"C1\"）；无标注时两者都是空数组。用完调 clear_marks 清除。",
        {},
    )
    async def get_user_marks(args):
        return await run("marks.get")

    @tool(
        "clear_marks",
        "清除用户标注（消费完后调用）。target: \"all\"（默认）| \"canvasRects\" | \"timeRanges\"。",
        {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "enum": ["all", "canvasRects", "timeRanges"],
                    "description": "清除哪类标注，默认 all",
                },
            },
        },
    )
    async def clear_marks(args):
        target = args.get("target")
        if not isinstance(target, str) or not target:
            target = "all"
        return await run("marks.clear", {"target": target})

    @tool(
        "execute_command",
        '在打开的 OpenCut 编辑器中执行一条编辑器命令。所有编辑器操作（timeline.*、keyframes.*、effects.*、masks.*、media.*、selection.*、scenes.* 等）都是本工具的子命令——顶层工具只有工具列表里列出的那些，不要猜测未列出的顶层工具名（如 masks.list 必须走本工具）。用 list_commands 发现可用命令。所有时间参数单位是秒（时间线绝对时间）。每条命令都走编辑器的命令系统，修改实时应用到预览且可撤销。接受 "elements" 数组的命令可传字符串 "$selection" 作用于用户当前选中（无选中时失败）；用 get_selection 工具查看当前选中。',
        {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "命令名，如 timeline.split_elements",
                },
                "args": {
                    "type": "object",
                    "description": "命令参数；参数提示见 list_commands",
                },
            },
            "required": ["command"],
        },
    )
    async def execute_command(args):
        command = args.get("command")
        if not isinstance(command, str) or not command:
            return _error("缺少必填参数: command")
        cmd_args = args.get("args")
        if not isinstance(cmd_args, dict):
            cmd_args = {}
        return await run(command, cmd_args)

    @tool(
        "get_preview_frame",
        "截取当前预览画面的一帧，返回降采样图（长边 1280）。可选传 time（秒）渲染指定时刻而不是当前播放头位置。用于修改后的视觉核验。要看清细节（小图标、文字、用户框选的区域）时传 rect——0~1 画布比例矩形，如 get_user_marks 的 canvasRects 条目——输出改为按该区域原生分辨率裁剪，不再降采样。目标是区域内的小子元素（图标、星形、徽标、小字）时，先截整个区域，再把 rect 收紧到该元素本身让它充满画面——只有几十原生像素宽的子元素在更大的裁剪图里无法辨认形状；禁止对着模糊亮点猜形状。",
        {
            "type": "object",
            "properties": {
                "time": {
                    "type": "number",
                    "description": "时间（秒）；缺省取当前播放头",
                },
                "rect": {
                    "type": "object",
                    "description": "可选 {left, top, right, bottom}，0~1 画布比例（与 get_user_marks canvasRects 同一坐标系）；把截图裁剪到该区域并按原生分辨率输出",
                },
            },
        },
    )
    async def get_preview_frame(args):
        payload = {}
        if isinstance(args.get("time"), (int, float)):
            payload["time"] = args["time"]
        rect = args.get("rect")
        if isinstance(rect, dict):
            cleaned = {
                k: rect[k]
                for k in ("left", "top", "right", "bottom")
                if isinstance(rect.get(k), (int, float)) and not isinstance(rect.get(k), bool)
            }
            if len(cleaned) != 4:
                return _error(
                    "rect 需要 left/top/right/bottom 四个数值（0~1 画布比例）"
                )
            payload["rect"] = cleaned
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
        meta["imageHandle"] = _register_image(base64_data, mime)
        return {
            "content": [
                {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
                {"type": "image", "data": base64_data, "mimeType": mime},
            ]
        }

    @tool(
        "get_preview_sequence",
        "一次调用在一个时间范围内抽样多帧，返回单张拼图：网格排列、每帧标注时间点。近同的相邻帧自动丢弃，静态段落压缩成一帧。用于低成本理解素材结构（这段视频发生了什么、场景切换在哪），需要看某一时刻的完整细节再调 get_preview_frame。长素材要拉大间隔：按 (end - start) / count 选一个合理步长，并向用户说明采样有多稀疏。",
        {
            "type": "object",
            "properties": {
                "start": {
                    "type": "number",
                    "description": "范围起点（秒，默认 0）",
                },
                "end": {
                    "type": "number",
                    "description": "范围终点（秒，默认项目时长）",
                },
                "count": {
                    "type": "number",
                    "description": "去重前抽样帧数（默认 9）。必须在 1~24 之间——超限会被拒绝而非截断；要更细就缩小 start/end 而不是加 count。",
                },
                "timestamps": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "显式指定抽样时间点（秒，最多 24 个）；传入后覆盖 start/end/count",
                },
                "cellWidth": {
                    "type": "number",
                    "description": "拼图每格像素宽，默认 320，允许 120~640（超出拒绝而非截断）。像素级细节请改用 get_preview_frame 加 rect。",
                },
            },
        },
    )
    async def get_preview_sequence(args):
        payload = {}
        for key in ("start", "end"):
            value = args.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                payload[key] = value
        cell_width = args.get("cellWidth")
        if isinstance(cell_width, (int, float)) and not isinstance(cell_width, bool):
            if cell_width < 120 or cell_width > 640:
                return _error(
                    f"cellWidth 必须在 120~640 之间（收到 {cell_width}）。"
                    "像素级细节请改用 get_preview_frame 加 rect。"
                )
            payload["cellWidth"] = cell_width
        count = args.get("count")
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            if count < 1 or count > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"count 必须在 1~{MAX_SEQUENCE_FRAMES} 之间（收到 {count}）。"
                    "要更细就缩小 start/end，而不是加 count。"
                )
            payload["count"] = count
        stamps = args.get("timestamps")
        if isinstance(stamps, list) and stamps:
            cleaned = [
                t
                for t in stamps
                if isinstance(t, (int, float)) and not isinstance(t, bool)
            ]
            if len(cleaned) > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"timestamps 最多 {MAX_SEQUENCE_FRAMES} 个（收到 {len(cleaned)} 个）。"
                )
            payload["timestamps"] = cleaned
        try:
            result = await call_editor(
                session_id, "preview.capture_sequence", payload
            )
        except Exception as e:
            return _error(str(e))
        data_url = (result or {}).get("dataUrl", "")
        base64_data = data_url.split(",", 1)[-1] if "," in data_url else data_url
        mime = "image/png"
        if data_url.startswith("data:") and ";" in data_url:
            mime = data_url[5 : data_url.index(";")]
        meta = {
            k: result[k]
            for k in ("width", "height", "sampled", "kept", "dropped", "frames")
            if k in (result or {})
        }
        meta["imageHandle"] = _register_image(base64_data, mime)
        return {
            "content": [
                {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
                {"type": "image", "data": base64_data, "mimeType": mime},
            ]
        }

    @tool(
        "read_media",
        "按素材 id 读取已导入素材的视觉内容——不碰时间线。"
        "图片返回图片本身；视频返回一张拼图（在指定时间范围抽帧，默认整段），"
        "每帧标注时间点，默认丢弃近同帧——采样语义与 get_preview_sequence 相同，"
        "要更细就缩小 start/end；音频无视觉内容，只返回元数据。素材 id 来自 "
        "media.list、get_editor_state 的 mediaAssets，或用户消息开头的 \"我引用的素材\" "
        "列表。查看素材库素材一律用本工具——绝不为了看一眼就把它插上时间线。",
        {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "素材 id",
                },
                "start": {
                    "type": "number",
                    "description": "仅视频：范围起点（秒，默认 0）",
                },
                "end": {
                    "type": "number",
                    "description": "仅视频：范围终点（秒，默认素材时长）",
                },
                "count": {
                    "type": "number",
                    "description": "仅视频：去重前抽样帧数（默认 9，最多 24——超限拒绝）",
                },
                "timestamps": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "仅视频：显式指定抽样时间点（秒，最多 24 个）；传入后覆盖 start/end/count",
                },
                "dedupe": {
                    "type": "boolean",
                    "description": "仅视频：丢弃近同帧（默认 true）",
                },
                "cellWidth": {
                    "type": "number",
                    "description": "仅视频：拼图每格像素宽，默认 320，允许 120~640（超出拒绝）",
                },
            },
            "required": ["id"],
        },
    )
    async def read_media(args):
        asset_id = args.get("id")
        if not isinstance(asset_id, str) or not asset_id:
            return _error("缺少必填参数: id")
        payload = {"id": asset_id}
        for key in ("start", "end"):
            value = args.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                payload[key] = value
        count = args.get("count")
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            if count < 1 or count > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"count 必须在 1~{MAX_SEQUENCE_FRAMES} 之间（收到 {count}）"
                )
            payload["count"] = count
        stamps = args.get("timestamps")
        if isinstance(stamps, list) and stamps:
            cleaned = [
                t
                for t in stamps
                if isinstance(t, (int, float)) and not isinstance(t, bool)
            ]
            if len(cleaned) > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"timestamps 最多 {MAX_SEQUENCE_FRAMES} 个（收到 {len(cleaned)} 个）。"
                )
            payload["timestamps"] = cleaned
        dedupe = args.get("dedupe")
        if isinstance(dedupe, bool):
            payload["dedupe"] = dedupe
        cell_width = args.get("cellWidth")
        if isinstance(cell_width, (int, float)) and not isinstance(cell_width, bool):
            if cell_width < 120 or cell_width > 640:
                return _error(
                    f"cellWidth 必须在 120~640 之间（收到 {cell_width}）"
                )
            payload["cellWidth"] = cell_width
        try:
            result = await call_editor(session_id, "media.read", payload)
        except Exception as e:
            return _error(str(e))
        meta = {
            k: result[k]
            for k in (
                "id",
                "name",
                "type",
                "duration",
                "width",
                "height",
                "sampled",
                "kept",
                "dropped",
                "frames",
                "note",
            )
            if k in (result or {})
        }
        data_url = (result or {}).get("dataUrl", "")
        if not data_url:
            return _text(meta)
        base64_data = data_url.split(",", 1)[-1] if "," in data_url else data_url
        mime = "image/png"
        if data_url.startswith("data:") and ";" in data_url:
            mime = data_url[5 : data_url.index(";")]
        meta["imageHandle"] = _register_image(base64_data, mime)
        return {
            "content": [
                {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
                {"type": "image", "data": base64_data, "mimeType": mime},
            ]
        }

    @tool(
        "supply_media_window",
        "把视频素材的一个时间窗口（在编辑器浏览器内）转码成小 WebM 上传到 gateway，"
        "返回渲染机（add_media HTML 里的 <video src>）可拉取的 URL。这是渲染机拿到"
        "原视频真实画面的唯一途径（剪辑窗口烘焙：转场/剪切）——mediaAssets 的 url 字段"
        "是浏览器本地 blob URL，渲染机访问不了，必须走本工具。窗口已预先切好，返回的 "
        "URL 不需要 #t= 片段；它恰好播放请求的窗口，含原音轨（Opus）。start/end 用素材"
        "自身时间轴的秒数（从时间线坐标经元素的 timeRange + 素材源偏移换算）。窗口保持 "
        "≤1.5s（转场的前后两半各一段），以限制烘焙 HTML 的帧缓存内存。窗口段自带原音轨"
        "（Opus）——当烘焙片段是替换时间线区段时（split 出被覆盖范围、把片段插回原位），"
        "在 add_media HTML 里用同一 src 单独挂一个 <audio> 元素接线音频（<video> 保持 "
        "muted）。",
        {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "视频素材 id（来自 media.list / get_editor_state 的 mediaAssets）",
                },
                "start": {
                    "type": "number",
                    "description": "窗口起点（秒，素材自身时间轴）",
                },
                "end": {
                    "type": "number",
                    "description": "窗口终点（秒）；必须大于 start",
                },
                "maxWidth": {
                    "type": "number",
                    "description": "输出宽度上限（像素，默认 1280，允许 320~1920）",
                },
            },
            "required": ["id", "start", "end"],
        },
    )
    async def supply_media_window(args):
        asset_id = args.get("id")
        if not isinstance(asset_id, str) or not asset_id:
            return _error("缺少必填参数: id")
        payload = {"id": asset_id}
        for key in ("start", "end"):
            value = args.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return _error(f"缺少必填参数: {key}")
            payload[key] = value
        if not payload["end"] > payload["start"]:
            return _error("end 必须大于 start")
        if payload["end"] - payload["start"] > MAX_SUPPLY_WINDOW_SECONDS:
            return _error(
                f"窗口过长（上限 {MAX_SUPPLY_WINDOW_SECONDS}s）；"
                "转场每半段保持 ≤1.5s"
            )
        max_width = args.get("maxWidth")
        if isinstance(max_width, (int, float)) and not isinstance(max_width, bool):
            if max_width < 320 or max_width > 1920:
                return _error(f"maxWidth 必须在 320~1920 之间（收到 {max_width}）")
            payload["maxWidth"] = max_width
        try:
            result = await call_editor(session_id, "media.supply_window", payload)
        except Exception as e:
            return _error(str(e))
        return _text(
            json.dumps(
                {
                    k: (result or {}).get(k)
                    for k in ("id", "url", "duration", "width", "uploadedBytes")
                },
                ensure_ascii=False,
            )
        )

    # ------------------------------------------------------------------
    # add_media：独立渲染素材工具，与 add_html 平级。add_html 产活特效元素
    # （文字可编辑、DOM/CSS/GSAP 动画），add_media 产固定像素素材（透明 WebM 视频 /
    # PNG 图片），供 Canvas/WebGL/shader/粒子等 DOM 序列化承载不了的视觉。
    # 迭代统一走 frames/image（headless 秒级回图、注册 imageHandle 供评委对比），
    # 达标后再 video 正式渲染（1~3 分钟）。内部渲染引擎为 fx_render（HyperFrames）。
    # ------------------------------------------------------------------
    @tool(
        "add_media",
        "把自包含 HTML/CSS 合成无头渲染（HyperFrames，帧精确的 CSS/WAAPI/GSAP 动画）成"
        "媒体素材。与 timeline.add_html 平级——按产物形态选型：add_html 产活特效元素"
        "（文字经 data-param 可编辑、编辑器内 DOM/CSS/GSAP 动画、成本近零）；add_media "
        "产固定像素——透明背景 VP9-alpha WebM 视频（或 PNG），作为生成特效素材导入"
        "（显示在特效面板的生成区，不进素材库）——用于 Canvas/WebGL/shader/粒子等 "
        "DOM 序列化留不住像素的视觉，或需要渲染好的视频素材时。"
        "迭代流程：先写 HTML，再用 format \"frames\"（动画）或 \"image\"（静态）迭代——"
        "每轮秒级、无头、透明背景、零工程污染；预览图带回 imageHandle 字段，可直接喂给 "
        "judge_visual。frames/image 通过评审后才渲染 format \"video\"（1~3 分钟），并按"
        "返回的 next 步骤导入。"
        "HTML：一份完整自包含文档，root 元素带 data-width=\"<px>\" data-height=\"<px>\""
        "（渲染视口），页面背景透明；有中文文字加 <meta charset=\"utf-8\">。HyperFrames "
        "契约属性（data-composition-id/data-start/data-duration/data-no-timeline）缺失时"
        "自动补齐——动画内容自己加 data-duration=\"<秒>\"（默认 5s）。动画：CSS "
        "@keyframes（有限循环次数 + animation-fill-mode:both）或一条 paused GSAP "
        "timeline 注册为 window.__timelines[\"main\"]（契约同 add_html；禁 repeat:-1、"
        "禁 Math.random/Date.now）。data-width/data-height 设为项目画布尺寸（见 "
        "get_editor_state），内容摆在它应出现在画面的位置——渲染产物 1:1 落到时间线；"
        "小画布（如 520x152 徽标）插入时会被 contain 放大。"
        "格式：\"frames\"——默认取时长 0.2/0.5/0.8 处的关键帧，或显式 \"timestamps\""
        "（最多 12 个；避开 t=0 与 t==duration，两者可能是空白帧），超过 4 帧拼成一张"
        "联系表返回；\"image\"——t=0 的静态 PNG；\"video\"（默认）——动画透明背景 "
        "WebM（普通 video 元素合成，无需混合模式）。"
        "视频帧源：要把真实画面烘进产物（如跨剪切点的转场片段），先对每个素材窗口"
        "（A 尾段 + B 首段）调 supply_media_window 拿渲染机可访问的 URL，再以声明式 "
        "<video src=\"<供给 url>\" data-start data-duration muted playsinline> 嵌入"
        "（窗口已切好，不需要 #t=）。HyperFrames 托管媒体播放——绝不加 crossorigin、"
        "绝不调 play/pause/seek、也绝不自己把帧预解码进离屏 canvas；渲染机提取真实帧"
        "并合成。每个 video 包一层不带时间的 wrapper 做运动（lint 拒绝带时间的 video "
        "嵌在带时间的祖先里；已实测的交叉淡化配方见 html-fx skill 的「视频帧源」一节）。"
        "渲染出的片段是不透明满幅画面：它盖住所落的时间线窗口，所以剪切点处无需 split。",
        {
            "type": "object",
            "properties": {
                "html": {
                    "type": "string",
                    "description": "完整自包含 HTML 文档；root 带 data-width/data-height；契约属性自动补齐",
                },
                "format": {
                    "type": "string",
                    "enum": ["video", "image", "frames"],
                    "description": '"video"：最终动画素材（带 alpha 的透明 WebM）；"image"：静态透明 PNG 素材；"frames"：迭代用关键帧预览（先用它，再 "video"）。默认 "video"。',
                },
                "timestamps": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": '仅 format "frames"：抽帧时间点（秒，0..data-duration 内，最多 12 个）。默认时长的 0.2/0.5/0.8 处。传 1~4 个逐帧看细节；传 6~12 个得一张呈现运动过程的联系表。',
                },
            },
            "required": ["html"],
        },
    )
    async def add_media_tool(args):
        html = args.get("html")
        if not isinstance(html, str) or not html.strip():
            return _error("缺少必填参数: html")
        format = args.get("format", "video")
        try:
            result = await fx_render.render_fx(
                session_id, html, format=format, timestamps=args.get("timestamps")
            )
        except fx_render.FxRenderError as e:
            return _error(str(e))
        except Exception as e:
            return _error(f"渲染异常: {type(e).__name__}: {e}")

        def _attach_previews(paths):
            images, handles = [], []
            for p in paths:
                try:
                    png = Path(p).read_bytes()
                except OSError as e:
                    logger.warning(f"读取特效预览失败: {e}")
                    continue
                b64 = base64.b64encode(png).decode("ascii")
                handles.append(_register_image(b64, "image/png"))
                images.append({"type": "image", "data": b64, "mimeType": "image/png"})
            return images, handles

        if result["kind"] == "frames":
            images, handles = _attach_previews(result.get("previewPaths") or [])
            payload = {
                "jobId": result["jobId"],
                "kind": "frames",
                "width": result["width"],
                "height": result["height"],
                "durationSeconds": result["durationSeconds"],
                "imageHandles": handles,
                "next": (
                    "附带图片是本次渲染在多个时间点的关键帧（按时间顺序排列；帧数多于 4 时"
                    "拼成一张联系表，每格上方标注时间点），不是参考图；已登记 imageHandle，"
                    "可直接传 judge_visual 的 imageHandles 与参考图对比。"
                    "与目标不一致就改 HTML 后仍以 format:'frames' 重新渲染（秒级）继续迭代，"
                    "不要直接 render video。确认达标后再改用 format:'video' 正式渲染"
                    "（约 1~3 分钟），并按返回的 next 步骤导入素材库插入时间轴。"
                ),
            }
            return {
                "content": [
                    {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)},
                    *images,
                ]
            }
        base = _editor_base_urls.get(session_id, "")
        if not base:
            return _error(
                "无法确定 Gateway 对外地址（编辑器未通过 WebSocket 连接）。"
                "请在 Gateway 配置 FX_PUBLIC_BASE_URL 后重试。"
            )
        url = (
            f"{base}/api/agent/sessions/{session_id}"
            f"/fx/{result['jobId']}/{result['fileName']}"
        )
        if result["kind"] == "image":
            next_steps = (
                "确认附带预览图与目标一致后再插入："
                '第一步：execute_command 执行 media.import（参数 name + url + ephemeral:true，产物进特效面板生成区、不进素材库），记录返回的 asset id；'
                '第二步：execute_command 执行 timeline.add_track（参数 type:"video"）新建 overlay 视频轨道，记录返回的 trackId；'
                "第三步：execute_command 执行 timeline.insert_element，element 为 "
                "{type:'image', mediaId: assetId, startTime, duration}，"
                "placement 用 {mode:'explicit', trackId}（显式落到刚建的 overlay 轨道，"
                "不要放 main 轨道，不要省略 trackId 用 auto——image/video 元素只能放 video 类轨道），无需混合模式"
            )
        else:
            next_steps = (
                '第一步：execute_command 执行 media.import（参数 name + url + ephemeral:true，产物进特效面板生成区、不进素材库），记录返回的 asset id；'
                '第二步：execute_command 执行 timeline.add_track（参数 type:"video"）新建 overlay 视频轨道，记录返回的 trackId；'
                "第三步：execute_command 执行 timeline.insert_element，element 为 "
                "{type:'video', mediaId: assetId, startTime, duration}"
                "（视频自带透明通道，无需混合模式），"
                "placement 用 {mode:'explicit', trackId}（显式落到刚建的 overlay 轨道，"
                "不要放 main 轨道，不要省略 trackId 用 auto——image/video 元素只能放 video 类轨道）"
            )
        next_steps += (
            "。落位尺寸：若 HTML 的 data-width/data-height 与项目画布尺寸一致，"
            "插入后即为设计稿位置，无需调 transform；不一致时用 timeline.update_elements "
            "设 transform.scaleX/scaleY/positionX/positionY 调整"
        )
        payload = {
            "jobId": result["jobId"],
            "kind": result["kind"],
            "url": url,
            "fileName": result["fileName"],
            "width": result["width"],
            "height": result["height"],
            "durationSeconds": result["durationSeconds"],
            "next": next_steps,
        }
        if result["kind"] == "image":
            images, handles = _attach_previews(
                [result["previewPath"]] if result.get("previewPath") else []
            )
            if images:
                payload["imageHandles"] = handles
                payload["preview"] = (
                    "附带图片就是本次渲染结果（透明区域显示为浅色棋盘格），不是参考图；"
                    "已登记 imageHandle，可直接传 judge_visual 与参考图对比。"
                    "与目标不一致就改 HTML 重新渲染；一致后再执行上面的 next 步骤。"
                )
                return {
                    "content": [
                        {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)},
                        *images,
                    ]
                }
        return _text(payload)

    @tool(
        "fx_components",
        "搜索并取用现成 HTML 特效组件（236 个自包含 HTML+CSS+JS 片段，带变量声明："
        "图表、故障、胶片颗粒、扫光、confetti、终端/代码窗口、徽标、跑马灯……）。"
        "手写任何点名视觉之前先按关键词搜索——命中就按名取片段、揉进你正在写的 HTML，"
        "不从零造。timeline.add_html 与 add_media 均适用（合并后仍是一份自包含文档）。"
        "变量值直接写死在 markup 里；文本类变量在用户需要继续编辑时映射成 data-param 槽位；"
        "片段里的动画由你自行接入 window.__timelines[\"main\"] 契约。传 query 搜索"
        "（返回带元数据的排序候选）或传 name 取片段完整原文。",
        {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词（匹配 name/tags/title/description；库内元数据为英文，用英文词命中率更高），空格分隔",
                },
                "name": {
                    "type": "string",
                    "description": "组件精确名称，取片段完整原文",
                },
            },
        },
    )
    async def fx_components_tool(args):
        name = args.get("name")
        if isinstance(name, str) and name.strip():
            item = fx_catalog.get(name.strip())
            if item is None:
                return _error(f"未找到组件 {name!r}，先用 query 搜索确认名称")
            return _text(item)
        query = args.get("query")
        if isinstance(query, str) and query.strip():
            matches = fx_catalog.search(query.strip())
            if not matches:
                return _text({"matches": [], "note": "无命中，换个关键词或手写"})
            return _text({"matches": matches})
        return _error("需要 query（搜索）或 name（取片段原文）之一")

    @tool(
        "judge_visual",
        "独立视觉评委：一次独立的 LLM 调用，检查效果图是否满足你写的 requirement，"
        "返回 pass/fail 与逐条理由。用作自定义视觉（HTML 特效、复刻样式）向用户汇报完成前的"
        "验收门禁——你自己的截图检查是初审，它是终审。"
        "图片来源：效果图来自 add_media 的 frames/image 预览（无头渲染——迭代期首选，"
        "零工程污染）或 get_preview_frame（画布合成图——插入后的最终合成核验）；参考图先用 "
        "read_media/get_preview_frame 读取——它们的 JSON 结果里有 imageHandle 字段；效果图"
        "句柄传 imageHandles（1~4 个），任务涉及源图时其句柄传 referenceHandles（0~4 个）。"
        "参考图句柄一经在此使用即固定、永不淘汰，同一张参考图可锚定多轮迭代。"
        "REQUIREMENT 写法：验收标准写在样式/颜色/结构/文字内容层面（如「藏青胶囊、全圆端、"
        "浅蓝发光描边；左侧实心五角星徽标；文字逐字 Business gets handed out」）。"
        "绝不写像素级数值——评委默认忽略像素级差异（描边粗细、发光强度、几像素偏移）与背景"
        "差异（参考帧可能带无关视频背景；只比对目标内容本体），除非你明确要求像素级一致。"
        "评委只按这段文字判——没写的不扣分。"
        "SIDE-BY-SIDE：恰好 1 效果图 + 1 参考图的复刻核对，设 sideBySide=true——两图拼成"
        "同尺度单图再评，避免跨图尺度/色差误判。pass=false 时按给出的理由迭代（改 HTML、"
        "重渲预览、重新评审）；通过后才可汇报完成。",
        {
            "type": "object",
            "properties": {
                "requirement": {
                    "type": "string",
                    "description": "验收标准：结果必须满足什么，包括参考图的使用方式（精确复刻还是风格借鉴）",
                },
                "imageHandles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "1~4 个被评效果图的句柄（img-N），如来自 add_media 预览或 get_preview_frame",
                },
                "referenceHandles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "0~4 个参考图句柄，效果图对照它们评判（固定、永不淘汰）",
                },
                "sideBySide": {
                    "type": "boolean",
                    "description": "true = 评判前把效果图与参考图拼成一张同尺度对比图；要求恰好 1 个 imageHandle + 1 个 referenceHandle；1:1 复刻核对推荐开启",
                },
            },
            "required": ["requirement", "imageHandles"],
        },
    )
    async def judge_visual_tool(args):
        requirement = args.get("requirement")
        if not isinstance(requirement, str) or not requirement.strip():
            return _error("缺少必填参数: requirement")

        def _resolve_handles(key: str, lo: int, hi: int) -> list[tuple[bytes, str]] | dict:
            handles = args.get(key)
            if handles is None:
                handles = []
            if (
                not isinstance(handles, list)
                or not lo <= len(handles) <= hi
                or not all(isinstance(h, str) for h in handles)
            ):
                return _error(f"{key} 必须是 {lo}~{hi} 个句柄字符串（img-N）")
            images: list[tuple[bytes, str]] = []
            for handle in handles:
                entry = image_handles.get(handle)
                if entry is None:
                    return _error(
                        f"图片句柄 {handle} 不存在或已被淘汰——"
                        "请重新调用 read_media/get_preview_frame 获取"
                    )
                b64_data, mime = entry
                try:
                    images.append((base64.b64decode(b64_data), mime))
                except Exception:
                    return _error(f"图片句柄 {handle} 数据损坏")
            return images

        result_images = _resolve_handles("imageHandles", 1, 4)
        if isinstance(result_images, dict):
            return result_images
        reference_images = _resolve_handles("referenceHandles", 0, 4)
        if isinstance(reference_images, dict):
            return reference_images
        pinned_handles.update(args.get("referenceHandles") or [])

        side_by_side = bool(args.get("sideBySide"))
        if side_by_side and (len(result_images) != 1 or len(reference_images) != 1):
            return _error("sideBySide 需要恰好 1 个 imageHandles + 1 个 referenceHandles")

        try:
            passed, verdict = await visual_judge.judge(
                requirement.strip(), result_images, reference_images,
                side_by_side=side_by_side,
            )
        except Exception as e:
            return _error(f"评委调用失败: {type(e).__name__}: {e}")
        return _text({"pass": passed, "verdict": verdict})

    return create_sdk_mcp_server(
        name="opencut",
        version="1.0.0",
        tools=[
            editor_status,
            list_commands,
            get_editor_state,
            get_selection,
            get_user_marks,
            execute_command,
            get_preview_frame,
            get_preview_sequence,
            read_media,
            supply_media_window,
            judge_visual_tool,
            add_media_tool,
            fx_components_tool,
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
    _editor_base_urls[session_id] = _derive_base_url(websocket)
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
            _editor_base_urls.pop(session_id, None)
            logger.info(f"[bridge] 编辑器已断开: session={session_id[:8]}")
        for req_id, (fut, timer, sid) in list(_pending.items()):
            if sid == session_id:
                timer.cancel()
                if not fut.done():
                    fut.set_exception(EditorNotConnectedError("编辑器连接已断开"))
                _pending.pop(req_id, None)
