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

from . import auth, config, db, visual_judge
# fx_render 暂时停用（工具块见下方注释），恢复时重新加入导入：
# from . import fx_render

logger = logging.getLogger("agent-gateway.bridge")

DEFAULT_TIMEOUT_SECONDS = 120
# 与前端 preview.capture_sequence 的 MAX_SEQUENCE_FRAMES 保持一致。
# 拼图面积决定 image token 成本，超过 24 帧后成本增长快而"看结构"的收益很低。
MAX_SEQUENCE_FRAMES = 24
COMMAND_TIMEOUTS: dict[str, float] = {
    "subtitles.transcribe": 900,
    "media.import": 600,
    "export.start": 1800,
    # 批量抽帧逐帧离屏渲染，24 帧在复杂工程上可能超过默认 120s
    "preview.capture_sequence": 300,
    # 视频素材离线抽帧，长 GOP 的 4K 素材多次 seek 解码可能较慢
    "media.read": 300,
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
        'Get the current editor state: project settings, scenes, tracks and elements (times in seconds), selection, playback position, undo/redo availability, and media assets. trackOrder lists every track in on-screen order (row 0 = the topmost row in the timeline UI); upper tracks render on top of the ones below them, and effect tracks only affect the picture below them. When the user refers to "the first/top/bottom track" or a layer number (第一层/最上面/最下面), map it through trackOrder rather than the main/overlay/audio grouping order.',
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
        "get_user_marks",
        "Get the user's visual marks for pointing at regions: canvasRects = rects the user drew on the preview (each with a label id like \"C1\", \"C2\", … shown on the rect, plus canvas fractions 0~1, top-left origin — the same coordinate system as masks.set_canvas_rect, usable directly as its rect; includes the playhead time in seconds it was drawn at; pass one as get_preview_frame's rect to get a native-resolution close-up of that region — the right way to see small details like icons or text clearly), timeRanges = time ranges the user marked on the timeline (each with a label id like \"T1\", \"T2\", … shown on the band; seconds). The user can mark several of each and points at one by its label (e.g. \"C1\"); both are empty arrays when nothing is marked. Clear them with execute_command marks.clear after use.",
        {},
    )
    async def get_user_marks(args):
        return await run("marks.get")

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
        "Capture a frame of the current preview as a downscaled image (long edge 1280). Optionally render at a specific time (seconds) instead of the current playhead position. Use this for visual feedback after making edits. To inspect fine details (small icons, text, a user-framed region), pass rect — a canvas-fraction rect 0~1, e.g. a canvasRects entry from get_user_marks — and the output is cropped to that region at native resolution instead of downscaled. When the target is a small sub-element inside the region (icon, star, badge, small text), first capture the whole region, then tighten rect onto that element itself so it fills the frame — a sub-element only a few dozen native pixels wide is not shape-recognizable inside a larger crop; never guess its shape from a blurred bright spot.",
        {
            "type": "object",
            "properties": {
                "time": {
                    "type": "number",
                    "description": "Time in seconds; defaults to current playhead",
                },
                "rect": {
                    "type": "object",
                    "description": "Optional {left, top, right, bottom} in canvas fractions 0~1 (same coordinates as get_user_marks canvasRects); crops the capture to that region at native resolution",
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
        "Sample several frames across a time range in ONE call and return a single contact sheet image: a grid of frames, each labelled with its timestamp. Near-identical consecutive frames are dropped automatically, so static stretches collapse into one frame. Use this to understand a clip's structure cheaply (what happens in this video, where are the scene changes), then call get_preview_frame when one moment needs full detail. Long clips need a wider spacing: pick count so that (end - start) / count is a sensible step, and tell the user how sparse the coverage is.",
        {
            "type": "object",
            "properties": {
                "start": {
                    "type": "number",
                    "description": "Range start in seconds (default 0)",
                },
                "end": {
                    "type": "number",
                    "description": "Range end in seconds (default project duration)",
                },
                "count": {
                    "type": "number",
                    "description": "Frames to sample before dedupe (default 9). Must be between 1 and 24 — larger values are rejected, not clamped; narrow start/end for finer detail instead.",
                },
                "timestamps": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "Explicit sample times in seconds (max 24 entries); overrides start/end/count",
                },
                "cellWidth": {
                    "type": "number",
                    "description": "Pixel width of each contact-sheet cell, default 320, allowed 120~640 (rejected outside that range, not clamped). For pixel-level detail, use get_preview_frame with rect instead.",
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
                    f"cellWidth must be between 120 and 640 (got {cell_width}). "
                    "For pixel-level detail, call get_preview_frame with rect instead."
                )
            payload["cellWidth"] = cell_width
        count = args.get("count")
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            if count < 1 or count > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"count must be between 1 and {MAX_SEQUENCE_FRAMES} "
                    f"(got {count}). For finer detail, narrow start/end "
                    "instead of raising count."
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
                    f"timestamps may contain at most {MAX_SEQUENCE_FRAMES} "
                    f"entries (got {len(cleaned)})."
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
        "Read the VISUAL content of an imported media asset by asset id — WITHOUT touching the timeline. "
        "Images return the picture itself; videos return one contact sheet of frames sampled across a "
        "time range (default the whole clip), each labelled with its timestamp, near-identical frames "
        "dropped by default — same sampling semantics as get_preview_sequence, narrow start/end for "
        "finer detail; audio has no visual content and returns metadata only. Asset ids come from "
        "media.list, get_editor_state mediaAssets, or the \"我引用的素材\" block at the start of a user "
        "message. ALWAYS use this to view a library asset — never insert it onto the timeline just to "
        "look at it.",
        {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Media asset id",
                },
                "start": {
                    "type": "number",
                    "description": "Video only: range start in seconds (default 0)",
                },
                "end": {
                    "type": "number",
                    "description": "Video only: range end in seconds (default asset duration)",
                },
                "count": {
                    "type": "number",
                    "description": "Video only: frames to sample before dedupe (default 9, max 24 — rejected outside that range)",
                },
                "timestamps": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": "Video only: explicit sample times in seconds (max 24 entries); overrides start/end/count",
                },
                "dedupe": {
                    "type": "boolean",
                    "description": "Video only: drop near-identical frames (default true)",
                },
                "cellWidth": {
                    "type": "number",
                    "description": "Video only: px width per cell, default 320, allowed 120~640 (rejected outside that range)",
                },
            },
            "required": ["id"],
        },
    )
    async def read_media(args):
        asset_id = args.get("id")
        if not isinstance(asset_id, str) or not asset_id:
            return _error("Missing required argument: id")
        payload = {"id": asset_id}
        for key in ("start", "end"):
            value = args.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                payload[key] = value
        count = args.get("count")
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            if count < 1 or count > MAX_SEQUENCE_FRAMES:
                return _error(
                    f"count must be between 1 and {MAX_SEQUENCE_FRAMES} (got {count})"
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
                    f"timestamps may contain at most {MAX_SEQUENCE_FRAMES} "
                    f"entries (got {len(cleaned)})."
                )
            payload["timestamps"] = cleaned
        dedupe = args.get("dedupe")
        if isinstance(dedupe, bool):
            payload["dedupe"] = dedupe
        cell_width = args.get("cellWidth")
        if isinstance(cell_width, (int, float)) and not isinstance(cell_width, bool):
            if cell_width < 120 or cell_width > 640:
                return _error(
                    f"cellWidth must be between 120 and 640 (got {cell_width})"
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

    # ------------------------------------------------------------------
    # fx_render 工具暂时停用（add_html 已覆盖大部分能力，只保留 add_html 路线）。
    # 以下整块仅注释、未删除；恢复时取消注释并重新加入下方 tools 列表即可。
    # ------------------------------------------------------------------
    # @tool(
    #     "fx_render",
    #     'Render a self-contained HTML/CSS composition with HyperFrames (headless Chrome, frame-accurate CSS/WAAPI/GSAP '
    #     'animation). Default flow for custom HTML visuals: try execute_command timeline.add_html FIRST — HTML/CSS '
    #     'animates directly in the editor via CSS @keyframes, text stays editable via data-param slots, near-zero '
    #     'cost. Escalate to fx_render only when the add_html result falls short; its output is a fixed image/video, '
    #     'so text is no longer editable (stay on add_html when the user needs editable text). Skip the add_html '
    #     'attempt and go straight to fx_render when the need clearly requires JS/GSAP/Canvas/WebGL animation or '
    #     'complex particle choreography: tech-style badges, glowing titles, particles, animated stickers, or '
    #     'replicating a reference image\'s look. The HTML page background '
    #     'must be transparent for every format. Three output formats: '
    #     '"video" (default) renders an animated transparent-background WebM (real alpha channel — dark content stays '
    #     'visible, no blend mode needed); "image" screenshots t=0 as a transparent-background PNG in seconds — for STATIC '
    #     'visuals (badges, labels, decorations with no animation); '
    #     '"frames" captures key frames (default 0.2/0.5/0.8 of the duration, or explicit "timestamps", up to 12) in '
    #     'seconds and attaches them as preview images — more than 4 frames come back as ONE contact sheet labelled with '
    #     'each timestamp (use it to check motion continuity/timing); ALWAYS use frames first for ANIMATED effects to '
    #     'iterate on the look cheaply (seconds per round, no browser round-trip), and only render the final "video" '
    #     '(1-3 minutes) once the frames match the target. The '
    #     'html argument must be a COMPLETE HTML document following the HyperFrames convention: <meta charset="utf-8"> '
    #     '(required, otherwise Chinese text renders as mojibake), <meta name="viewport" '
    #     'content="width=W,height=H">, and a root element carrying data-composition-id="main" data-start="0" '
    #     'data-duration="<seconds>" data-width="<px>" data-height="<px>" data-fps="<project fps>"; children carry class "clip" with '
    #     'data-start/data-duration/data-track-index. Drive animation with exactly ONE paused GSAP timeline registered as '
    #     'window.__timelines["main"] = gsap.timeline({paused:true}) (key = data-composition-id; no repeat:-1, no '
    #     'Math.random/Date.now) — a composition without a registered timeline (e.g. CSS @keyframes only) stalls ~45s '
    #     'waiting for timeline readiness on every render. Set data-width/data-height to the PROJECT canvas size (see '
    #     'get_editor_state) and position the content inside the HTML where it should appear on screen — the rendered '
    #     'asset then drops onto the timeline 1:1; a small canvas (e.g. a 520x152 badge) gets contain-scaled up to fill '
    #     'the project canvas on insert. Video rendering takes 1-3 minutes; image/frames take seconds. Returns a '
    #     'URL plus the exact next steps (media.import with url, then timeline.insert_element). With format "image" the '
    #     'rendered preview is attached as an image, transparent areas shown as a light checkerboard — look at it and '
    #     'fix the HTML and re-render until it matches the target, instead of importing on the first try.',
    #     {
    #         "type": "object",
    #         "properties": {
    #             "html": {
    #                 "type": "string",
    #                 "description": "Complete HTML document following the HyperFrames composition convention",
    #             },
    #             "format": {
    #                 "type": "string",
    #                 "enum": ["video", "image", "frames"],
    #                 "description": '"video": animated effect (transparent-background WebM with alpha, plain video element, no blend mode); "image": static visual (transparent-background PNG, plain image element, no blend mode); "frames": key-frame previews of an animated effect (use first to iterate, then "video" for the final render). Default "video".',
    #             },
    #             "timestamps": {
    #                 "type": "array",
    #                 "items": {"type": "number"},
    #                 "description": 'Only for format "frames": seconds to capture (within 0..data-duration, max 12). Default 0.2/0.5/0.8 of the duration. Pass 1-4 timestamps to inspect details frame by frame; pass 6-12 to get one contact sheet showing the motion over time.',
    #             },
    #         },
    #         "required": ["html"],
    #     },
    # )
    # async def fx_render_tool(args):
    #     html = args.get("html")
    #     if not isinstance(html, str) or not html.strip():
    #         return _error("Missing required argument: html")
    #     format = args.get("format", "video")
    #     try:
    #         result = await fx_render.render_fx(
    #             session_id, html, format=format, timestamps=args.get("timestamps")
    #         )
    #     except fx_render.FxRenderError as e:
    #         return _error(str(e))
    #     except Exception as e:
    #         return _error(f"渲染异常: {type(e).__name__}: {e}")
    #     if result["kind"] == "frames":
    #         payload = {
    #             "jobId": result["jobId"],
    #             "kind": "frames",
    #             "width": result["width"],
    #             "height": result["height"],
    #             "durationSeconds": result["durationSeconds"],
    #             "next": (
    #                 "附带图片是本次渲染在多个时间点的关键帧（按时间顺序排列；帧数多于 4 时"
    #                 "拼成一张联系表，每格上方标注时间点），不是参考图。"
    #                 "逐帧核对画面与运动过程是否符合预期；与目标不一致就改 HTML 后仍以 format:'frames' "
    #                 "重新渲染（秒级）继续迭代，不要直接 render video。确认一致后再改用 "
    #                 "format:'video' 正式渲染（约 1~3 分钟），并按返回的 next 步骤插入时间轴。"
    #             ),
    #         }
    #         images = []
    #         for preview_path in result.get("previewPaths") or []:
    #             try:
    #                 images.append(Path(preview_path).read_bytes())
    #             except OSError as e:
    #                 logger.warning(f"读取特效关键帧预览失败: {e}")
    #         content: list = [
    #             {
    #                 "type": "text",
    #                 "text": json.dumps(payload, ensure_ascii=False, indent=2),
    #             }
    #         ]
    #         for png in images:
    #             content.append(
    #                 {
    #                     "type": "image",
    #                     "data": base64.b64encode(png).decode("ascii"),
    #                     "mimeType": "image/png",
    #                 }
    #             )
    #         return {"content": content}
    #     base = _editor_base_urls.get(session_id, "")
    #     if not base:
    #         return _error(
    #             "无法确定 Gateway 对外地址（编辑器未通过 WebSocket 连接）。"
    #             "请在 Gateway 配置 FX_PUBLIC_BASE_URL 后重试。"
    #         )
    #     url = (
    #         f"{base}/api/agent/sessions/{session_id}"
    #         f"/fx/{result['jobId']}/{result['fileName']}"
    #     )
    #     if result["kind"] == "image":
    #         next_steps = (
    #             "确认附带预览图与目标一致后再插入："
    #             '第一步：execute_command 执行 media.import（参数 name + url）导入素材库，记录返回的 asset id；'
    #             '第二步：execute_command 执行 timeline.add_track（参数 type:"video"）新建 overlay 视频轨道，记录返回的 trackId；'
    #             "第三步：execute_command 执行 timeline.insert_element，element 为 "
    #             "{type:'image', mediaId: assetId, startTime, duration}，"
    #             "placement 用 {mode:'explicit', trackId}（显式落到刚建的 overlay 轨道，"
    #             "不要放 main 轨道，不要省略 trackId 用 auto——image/video 元素只能放 video 类轨道），无需混合模式"
    #         )
    #     else:
    #         next_steps = (
    #             '第一步：execute_command 执行 media.import（参数 name + url）导入素材库，记录返回的 asset id；'
    #             '第二步：execute_command 执行 timeline.add_track（参数 type:"video"）新建 overlay 视频轨道，记录返回的 trackId；'
    #             "第三步：execute_command 执行 timeline.insert_element，element 为 "
    #             "{type:'video', mediaId: assetId, startTime, duration}"
    #             "（视频自带透明通道，无需混合模式），"
    #             "placement 用 {mode:'explicit', trackId}（显式落到刚建的 overlay 轨道，"
    #             "不要放 main 轨道，不要省略 trackId 用 auto——image/video 元素只能放 video 类轨道）"
    #         )
    #     next_steps += (
    #         "。落位尺寸：若 HTML 的 data-width/data-height 与项目画布尺寸一致，"
    #         "插入后即为设计稿位置，无需调 transform；不一致时用 timeline.update_elements "
    #         "设 transform.scaleX/scaleY/positionX/positionY 调整"
    #     )
    #     payload = {
    #         "jobId": result["jobId"],
    #         "kind": result["kind"],
    #         "url": url,
    #         "fileName": result["fileName"],
    #         "width": result["width"],
    #         "height": result["height"],
    #         "durationSeconds": result["durationSeconds"],
    #         "next": next_steps,
    #     }
    #     preview_path = result.get("previewPath") or ""
    #     png = b""
    #     if preview_path:
    #         try:
    #             png = Path(preview_path).read_bytes()
    #         except OSError as e:
    #             logger.warning(f"读取特效预览图失败: {e}")
    #     if png:
    #         payload["preview"] = (
    #             "附带图片就是本次渲染结果（透明区域显示为浅色棋盘格），不是参考图。"
    #             "先按 system prompt 的核对项逐条看图，与目标不一致就改 HTML 重新 fx_render；"
    #             "一致后再执行上面的 next 步骤。"
    #         )
    #         return {
    #             "content": [
    #                 {
    #                     "type": "text",
    #                     "text": json.dumps(payload, ensure_ascii=False, indent=2),
    #                 },
    #                 {
    #                     "type": "image",
    #                     "data": base64.b64encode(png).decode("ascii"),
    #                     "mimeType": "image/png",
    #                 },
    #             ]
    #         }
    #     return _text(payload)

    @tool(
        "judge_visual",
        "Independent visual judge: a separate LLM call that checks whether result image(s) meet the "
        "requirement you state, and answers pass/fail with per-item reasons. Use it as the acceptance gate "
        "for custom visuals (HTML effects, replicated styles) before reporting completion to the user — "
        "your own screenshot check is the draft review, this is the final review. "
        "HOW TO FEED IMAGES: capture the result with get_preview_frame (on-canvas composite) and read "
        "references with read_media/get_preview_frame first — their JSON results contain imageHandle "
        "fields; pass result handles as imageHandles (1~4) and, when the task references source images, "
        "those handles as referenceHandles (0~4). Reference handles are pinned once used here and never "
        "expire, so the same reference can anchor many iteration rounds. "
        "REQUIREMENT: write the acceptance criteria verbatim from the user's ask (e.g. '1:1 replicate the "
        "badge in the reference, exact text NEW' or 'same glowing style as the reference but text 限时优惠'). "
        "The judge scores ONLY against this text — anything not stated is not penalized, so be specific: "
        "for 1:1 replication state QUANTIFIED criteria (relative sizes/positions like 'star diameter ≈ 60% "
        "of capsule height, its halo nearly touching the left rounded cap', colours, verbatim text) — "
        "holistic phrases like 'same style' are unjudgeable. "
        "SIDE-BY-SIDE: for a 1:1 replica check with exactly 1 result + 1 reference, set sideBySide=true — "
        "the two are composited into one same-scale image, avoiding cross-image scale/colour misjudgement. "
        "On pass=false, iterate with the stated reasons (fix the HTML/params, re-capture, re-judge); "
        "report completion only after a pass.",
        {
            "type": "object",
            "properties": {
                "requirement": {
                    "type": "string",
                    "description": "Acceptance criteria: what the result must satisfy, including how reference images should be used (exact replica vs style reference)",
                },
                "imageHandles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "1~4 image handles (img-N) of the RESULT to be judged, e.g. from get_preview_frame",
                },
                "referenceHandles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "0~4 image handles of reference images the result is judged against (pinned, never expire)",
                },
                "sideBySide": {
                    "type": "boolean",
                    "description": "true = composite result and reference into one same-scale side-by-side image before judging; requires exactly 1 imageHandle + 1 referenceHandle; recommended for 1:1 replication checks",
                },
            },
            "required": ["requirement", "imageHandles"],
        },
    )
    async def judge_visual_tool(args):
        requirement = args.get("requirement")
        if not isinstance(requirement, str) or not requirement.strip():
            return _error("Missing required argument: requirement")

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
            judge_visual_tool,
            # fx_render_tool,  # fx_render 暂时停用（见上方注释块），恢复时取消注释
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
