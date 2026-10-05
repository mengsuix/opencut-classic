"""HyperFrames 特效渲染：agent 提交 HTML → 本机渲染透明 WebM → 静态路由回传浏览器

链路：fx.render MCP 工具 → render_fx()（npx 固定版本 HyperFrames，无头 Chrome 逐帧捕获）
→ AGENT_DATA_DIR/fx/<session_id>/<job_id>/renders/fx.webm
→ GET /api/agent/sessions/{sid}/fx/{job_id}/{file_name}（api/fx.py，带会话归属校验）
→ 浏览器 media.import(url) 拉取入库。

视频产物为 VP9 alpha WebM（页面透明背景即视频透明），前端解码保留 alpha，
按普通混合直接叠加，无需 screen 混合。

已知边界：HTML 内的 JS 会在渲染机 Chrome 中执行并可访问网络（HyperFrames 模板
依赖 CDN），当前与 agent 同信任级，未做网络沙箱；如需多租户强隔离再加固。
"""

import asyncio
import logging
import re
import shutil
import time
import uuid
from pathlib import Path

from . import config

logger = logging.getLogger("agent-gateway.fx_render")

# 视频渲染吃满 CPU/内存，全局串行避免多会话并发渲染互相拖垮；
# snapshot（image/frames）秒级完成，放宽到 3 并发，
# 否则一个会话的 1~3 分钟视频渲染会堵死其他会话的秒级预览
_RENDER_SEMAPHORE = asyncio.Semaphore(1)
_SNAPSHOT_SEMAPHORE = asyncio.Semaphore(3)

JOB_ID_RE = re.compile(r"^fx-\d+-[0-9a-f]{8}$")
OUTPUT_FILE_NAME_RE = re.compile(r"^[\w][\w.-]*\.(mp4|webm|png)$")

# 画布尺寸/时长读取自 HTML 的 HyperFrames 约定属性（root 元素上的 data-*）
_ATTR_RES = {
    "width": re.compile(r'data-width="(\d+)"'),
    "height": re.compile(r'data-height="(\d+)"'),
    "duration": re.compile(r'data-duration="([\d.]+)"'),
}
_ATTR_LIMITS = {
    # 下限 32px：徽章/胶囊等小尺寸静态特效（如 520×152）不需要放大渲染凑尺寸
    "width": (32, 3840, 1920),
    "height": (32, 3840, 1080),
    "duration": (0.5, 60, 5.0),
}
MAX_HTML_BYTES = 512 * 1024

# 回给模型的预览图：长边限幅（与前端 preview.capture 的降采样口径一致），
# 透明区铺浅色棋盘格——RGBA 直接交给模型时 alpha 会被丢弃，透明区看起来像黑底/白底，
# 容易让模型去改本来正确的 HTML；低对比棋盘格既能表达"这里是透明的"，又不干扰看发光/描边细节。
PREVIEW_MAX_EDGE = 1280
PREVIEW_CHECKER_CELL = 8
PREVIEW_LIGHT = "#FFFFFF"
PREVIEW_DARK = "#EDEDED"

# frames：最多抽帧数；不超过 PREVIEW_SINGLE_MAX 帧逐张回传（看细节），
# 超过则拼成一张带时间戳的联系表（看运动连贯性，省 token）
FRAMES_MAX = 12
PREVIEW_SINGLE_MAX = 4
SHEET_GAP = 6
SHEET_LABEL_HEIGHT = 26
SHEET_BG = "#2B2B2B"

VIDEO_FILE_NAME = "fx.webm"


class FxRenderError(RuntimeError):
    """渲染失败（参数非法 / 渲染进程失败 / 无产物）"""


_ROOT_TAG_RE = re.compile(
    r"<(?P<tag>[a-zA-Z][\w-]*)"
    r"(?P<attrs>(?:[^>\"]|\"[^\"]*\")*?\bdata-width\s*=\s*\"\d+\")"
    r"(?P<rest>(?:[^>\"]|\"[^\"]*\")*)>"
)


def _prepare_html(html: str, timestamps: list[float] | None) -> str:
    """把 add_html 约定的 HTML 补齐成 HyperFrames composition（一份 HTML 双路通用）：
    root（第一个带 data-width 的元素）缺啥补啥——data-composition-id/data-start/
    data-duration；无 window.__timelines 时补 data-no-timeline 跳过 45s 注册等待。
    自补的 duration 至少覆盖最后一个抽帧点 +0.5s（t==duration 的帧是空白）。
    另补 <meta charset> 防中文乱码。
    """
    match = _ROOT_TAG_RE.search(html)
    if not match:
        raise FxRenderError(
            "html 的 root 元素缺少 data-width/data-height（与 add_html 约定一致）"
        )
    attrs = match.group("attrs") + match.group("rest")
    inject = ""
    if "data-composition-id" not in attrs:
        inject += ' data-composition-id="main"'
    if "data-start" not in attrs:
        inject += ' data-start="0"'
    if "data-duration" not in attrs:
        duration = _ATTR_LIMITS["duration"][2]
        valid_ts = [
            t
            for t in (timestamps or [])
            if isinstance(t, (int, float)) and not isinstance(t, bool)
        ]
        if valid_ts:
            duration = max(duration, max(valid_ts) + 0.5)
        inject += f' data-duration="{duration:g}"'
    if "window.__timelines" not in html and "data-no-timeline" not in attrs:
        inject += " data-no-timeline"
    if inject:
        tag_end = match.start() + len(f"<{match.group('tag')}")
        html = html[:tag_end] + inject + html[tag_end:]
    if "charset" not in html.lower():
        head = re.search(r"<head[^>]*>", html, re.IGNORECASE)
        if head:
            html = html[: head.end()] + '<meta charset="utf-8">' + html[head.end() :]
        else:
            html = '<meta charset="utf-8">' + html
    return html


# agent 生成的 HTML 基本都用 jsdelivr 的 GSAP CDN。渲染机每次冷启动都跨外网下载
# （实测 3.3s/72KB，网络波动会撞 HyperFrames 10s 导航超时导致渲染失败），
# 故渲染前替换为本地缓存的内联脚本；缓存失败则保留 CDN 引用（降级不影响正确性）。
GSAP_CDN_SCRIPT_RE = re.compile(
    r'<script[^>]*\bsrc="https://cdn\.jsdelivr\.net/npm/gsap@3[^"]*"[^>]*>\s*</script>',
    re.IGNORECASE,
)
_GSAP_CDN_URL = "https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"


async def _inline_gsap_cdn(html: str) -> str:
    if not GSAP_CDN_SCRIPT_RE.search(html):
        return html
    cache = config.AGENT_DATA_DIR / "vendor" / "gsap.min.js"
    if not cache.is_file():
        try:
            await asyncio.to_thread(_download_file, _GSAP_CDN_URL, cache)
        except Exception as e:
            logger.warning(f"GSAP 本地缓存失败，保留 CDN 引用: {type(e).__name__}: {e}")
            return html
    try:
        script = cache.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning(f"GSAP 缓存读取失败，保留 CDN 引用: {e}")
        return html
    inline = f"<script>{script}</script>"
    return GSAP_CDN_SCRIPT_RE.sub(lambda _: inline, html)


def _download_file(url: str, dest: Path) -> None:
    import urllib.request

    # 显式禁用代理：macOS 系统代理常为 SOCKS，urllib 会把它当 HTTP 代理导致
    # SSL WRONG_VERSION_NUMBER；CDN 直连即可（实测 <1s）。环境必须走代理时
    # 下载失败，上层降级为保留 CDN 引用，不影响正确性。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    with opener.open(url, timeout=20) as resp:
        tmp.write_bytes(resp.read())
    tmp.replace(dest)


def _parse_composition(html: str) -> tuple[int, int, float]:
    values: dict[str, float] = {}
    for key, pattern in _ATTR_RES.items():
        lo, hi, default = _ATTR_LIMITS[key]
        match = pattern.search(html)
        value = float(match.group(1)) if match else default
        if not lo <= value <= hi:
            raise FxRenderError(f"HTML 中 data-{key}={value:g} 超出允许范围 {lo}~{hi}")
        values[key] = value
    return int(values["width"]), int(values["height"]), values["duration"]


async def render_fx(
    session_id: str,
    html: str,
    *,
    format: str = "video",
    timestamps: list[float] | None = None,
) -> dict:
    """渲染一个特效 HTML，返回产物信息（路径/尺寸/时长/kind）

    format:
      "video" — HyperFrames render，透明背景 VP9 alpha WebM（普通混合直接叠加）
      "image" — HyperFrames snapshot，透明背景 PNG（静态特效，直接作 image 元素）
      "frames" — HyperFrames snapshot 多时间点关键帧（动态特效的秒级预览，
                 多轮迭代确认效果后再用 "video" 正式渲染）；timestamps 缺省
                 取 0.2/0.5/0.8 倍时长，超过 PREVIEW_SINGLE_MAX 帧时拼成一张联系表
    """
    if format not in ("video", "image", "frames"):
        raise FxRenderError(f"format 只支持 video/image/frames（got {format!r}）")
    if not isinstance(html, str) or not html.strip():
        raise FxRenderError("html 不能为空")
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise FxRenderError(f"html 超过 {MAX_HTML_BYTES // 1024}KB 上限")
    html = _prepare_html(html, timestamps if format == "frames" else None)
    html = await _inline_gsap_cdn(html)
    width, height, duration = _parse_composition(html)
    if format == "frames":
        at_list = _validate_timestamps(timestamps, duration)

    job_id = f"fx-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    work_dir = config.AGENT_DATA_DIR / "fx" / session_id / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "index.html").write_text(html, encoding="utf-8")

    if format == "video":
        async with _RENDER_SEMAPHORE:
            stdout = await _run_render(work_dir)
    else:
        at = "0" if format == "image" else ",".join(f"{t:.2f}" for t in at_list)
        async with _SNAPSHOT_SEMAPHORE:
            stdout = await _run_snapshot(work_dir, at=at)

    if format == "image":
        # 按文件名排序：snapshot 产物命名 frame-NN-at-<t>s.png（零填充序号），
        # 名字序即时间序；mtime 同秒写盘会乱序
        frames = sorted((work_dir / "renders").glob("frame-*.png"))
        if not frames:
            tail = "\n".join(stdout.splitlines()[-15:])
            raise FxRenderError(f"渲染未产出 PNG。渲染日志尾部：\n{tail}")
        # 预览图放在 work_dir 而不是 renders/：它只给模型看，不必经静态路由暴露给浏览器
        preview = work_dir / "preview.png"
        preview_ok = _make_preview(frames[-1], preview)
        return {
            "jobId": job_id,
            "fileName": frames[-1].name,
            "width": width,
            "height": height,
            "durationSeconds": 0.0,
            "kind": "image",
            "path": str(frames[-1]),
            "previewPath": str(preview) if preview_ok else "",
        }

    if format == "frames":
        frames = sorted((work_dir / "renders").glob("frame-*.png"))
        if not frames:
            tail = "\n".join(stdout.splitlines()[-15:])
            raise FxRenderError(f"渲染未产出 PNG。渲染日志尾部：\n{tail}")
        preview_paths: list[str] = []
        if len(frames) > PREVIEW_SINGLE_MAX:
            sheet = work_dir / "preview-sheet.png"
            labels = [f"t={t:.2f}s" for t in at_list]
            if _make_contact_sheet(frames, labels, sheet):
                preview_paths.append(str(sheet))
        else:
            for i, frame in enumerate(frames):
                preview = work_dir / f"preview-{i}.png"
                if _make_preview(frame, preview):
                    preview_paths.append(str(preview))
        return {
            "jobId": job_id,
            "fileName": frames[-1].name,
            "width": width,
            "height": height,
            "durationSeconds": duration,
            "kind": "frames",
            "path": str(frames[-1]),
            "previewPaths": preview_paths,
        }

    output = work_dir / "renders" / VIDEO_FILE_NAME
    if not output.is_file():
        tail = "\n".join(stdout.splitlines()[-15:])
        raise FxRenderError(f"渲染未产出视频文件。渲染日志尾部：\n{tail}")
    return {
        "jobId": job_id,
        "fileName": output.name,
        "width": width,
        "height": height,
        "durationSeconds": duration,
        "kind": "video",
        "path": str(output),
    }


def _validate_timestamps(timestamps: list[float] | None, duration: float) -> list[float]:
    """frames 抽帧时间点：缺省 0.2/0.5/0.8 倍时长（覆盖入场中段、中间态与接近稳态，
    避开 t=0 入场前空白与末尾）；显式传入时去重升序（snapshot 产物按序号命名，
    与这里的顺序一一对应，联系表标签依赖该对应关系）。"""
    if timestamps is None:
        return [round(duration * f, 2) for f in (0.2, 0.5, 0.8)]
    if not isinstance(timestamps, list) or not timestamps:
        raise FxRenderError("timestamps 必须是非空数组（秒）")
    values: set[float] = set()
    for t in timestamps:
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            raise FxRenderError(f"timestamps 含非法值 {t!r}")
        if not 0 <= t <= duration:
            raise FxRenderError(f"timestamps 中 {t:g} 超出 0~{duration:g} 秒")
        values.add(round(float(t), 2))
    if len(values) > FRAMES_MAX:
        raise FxRenderError(f"timestamps 最多 {FRAMES_MAX} 个（got {len(values)}）")
    return sorted(values)


def _make_preview(src: Path, dest: Path) -> bool:
    """把渲染出的透明 PNG 做成给模型看的预览图：长边限幅 + 透明区铺浅色棋盘格。

    失败（缺 Pillow / 解码异常）返回 False，渲染产物本身照常返回，不因此报错。
    """
    try:
        _checker_preview(src, PREVIEW_MAX_EDGE).save(dest, format="PNG", optimize=True)
        return True
    except Exception as e:
        logger.warning(f"预览图生成失败（渲染产物不受影响）: {type(e).__name__}: {e}")
        return False


def _checker_preview(src: Path, max_edge: int):
    """读入透明 PNG，长边限到 max_edge，透明区铺浅色棋盘格，返回 RGB Image"""
    from PIL import Image, ImageDraw

    with Image.open(src) as opened:
        img = opened.convert("RGBA")
    longest = max(img.size)
    if longest > max_edge:
        scale = max_edge / longest
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.Resampling.LANCZOS,
        )
    background = Image.new("RGB", img.size, PREVIEW_LIGHT)
    draw = ImageDraw.Draw(background)
    cell = PREVIEW_CHECKER_CELL
    for y in range(0, img.height, cell):
        for x in range(0, img.width, cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=PREVIEW_DARK)
    background.paste(img, (0, 0), img)
    return background


def _make_contact_sheet(frames: list[Path], labels: list[str], dest: Path) -> bool:
    """多帧拼成一张联系表：总宽 PREVIEW_MAX_EDGE，每格上方标注时间戳，按时间从左到右、从上到下"""
    try:
        from PIL import Image, ImageDraw, ImageFont

        n = len(frames)
        cols = 2 if n <= 4 else 3 if n <= 9 else 4
        rows = -(-n // cols)
        cell_w = (PREVIEW_MAX_EDGE - SHEET_GAP * (cols + 1)) // cols
        cells = [_checker_preview(f, cell_w) for f in frames]
        cell_h = max(c.height for c in cells)
        row_h = SHEET_LABEL_HEIGHT + cell_h
        sheet = Image.new(
            "RGB",
            (PREVIEW_MAX_EDGE, SHEET_GAP + rows * (row_h + SHEET_GAP)),
            SHEET_BG,
        )
        draw = ImageDraw.Draw(sheet)
        font = ImageFont.load_default(size=18)
        for i, (cell, label) in enumerate(zip(cells, labels)):
            x = SHEET_GAP + (i % cols) * (cell_w + SHEET_GAP)
            y = SHEET_GAP + (i // cols) * (row_h + SHEET_GAP)
            draw.text((x + 4, y + 3), label, fill="#FFFFFF", font=font)
            sheet.paste(cell, (x, y + SHEET_LABEL_HEIGHT))
        sheet.save(dest, format="PNG", optimize=True)
        return True
    except Exception as e:
        logger.warning(f"联系表生成失败（渲染产物不受影响）: {type(e).__name__}: {e}")
        return False


async def _run_snapshot(work_dir: Path, at: str = "0") -> str:
    """snapshot 截取指定时间点的帧为 PNG（透明背景保留），秒级完成"""
    cmd = [
        "npx",
        "--yes",
        f"hyperframes@{config.FX_HYPERFRAMES_VERSION}",
        "snapshot",
        "--no-end",
        "--at",
        at,
        "-o",
        str(work_dir / "renders"),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as e:
        raise FxRenderError(f"无法启动 npx（渲染机需要 Node.js 环境）: {e}") from e
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(), timeout=config.FX_RENDER_TIMEOUT_SECONDS
        )
    except TimeoutError:
        proc.kill()
        raise FxRenderError(
            f"渲染超时（>{config.FX_RENDER_TIMEOUT_SECONDS:.0f}s），已终止"
        ) from None
    except asyncio.CancelledError:
        # 工具调用被取消（如用户中断本轮对话）时杀掉渲染进程，
        # 否则子进程会继续占着渲染信号量跑到超时
        proc.kill()
        raise
    text = stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        tail = "\n".join(text.splitlines()[-15:])
        raise FxRenderError(f"渲染进程失败（exit={proc.returncode}）：\n{tail}")
    return text


# job 目录名 fx-<epoch>-<rand> 内嵌创建时间戳，清理时直接解析，不依赖 mtime
_JOB_TS_RE = re.compile(r"^fx-(\d+)-[0-9a-f]{8}$")


def cleanup_fx_artifacts(max_age_seconds: float, now: float | None = None) -> int:
    """删除超过 max_age_seconds 的特效产物目录（data/fx/<session>/<job>），返回删除数"""
    fx_root = config.AGENT_DATA_DIR / "fx"
    if not fx_root.is_dir():
        return 0
    cutoff = (now if now is not None else time.time()) - max_age_seconds
    removed = 0
    for job_dir in fx_root.glob(f"*/*"):
        if not job_dir.is_dir():
            continue
        match = _JOB_TS_RE.match(job_dir.name)
        if not match or int(match.group(1)) >= cutoff:
            continue
        try:
            shutil.rmtree(job_dir)
            removed += 1
        except OSError as e:
            logger.warning(f"清理特效产物失败: {job_dir}: {e}")
    return removed


async def warmup_hyperframes() -> None:
    """启动时预热 npx 缓存（fire-and-forget），避免首个渲染任务撞上包安装"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "npx",
            "--yes",
            f"hyperframes@{config.FX_HYPERFRAMES_VERSION}",
            "--version",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.communicate(), timeout=120)
    except Exception as e:
        logger.warning(f"HyperFrames 预热失败（不影响后续渲染，首个任务会自行安装）: {e}")


async def _run_render(work_dir: Path) -> str:
    cmd = [
        "npx",
        "--yes",
        f"hyperframes@{config.FX_HYPERFRAMES_VERSION}",
        "render",
        "--quiet",
        # WebM = VP9 + alpha：页面透明背景直接成为视频透明通道；
        # 帧率取 root 的 data-fps（agent 按项目 fps 填），缺省 30
        "--format",
        "webm",
        "-o",
        str(work_dir / "renders" / VIDEO_FILE_NAME),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as e:
        raise FxRenderError(f"无法启动 npx（渲染机需要 Node.js 环境）: {e}") from e
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(), timeout=config.FX_RENDER_TIMEOUT_SECONDS
        )
    except TimeoutError:
        proc.kill()
        raise FxRenderError(
            f"渲染超时（>{config.FX_RENDER_TIMEOUT_SECONDS:.0f}s），已终止"
        ) from None
    except asyncio.CancelledError:
        proc.kill()
        raise
    text = stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        tail = "\n".join(text.splitlines()[-15:])
        raise FxRenderError(f"渲染进程失败（exit={proc.returncode}）：\n{tail}")
    return text
