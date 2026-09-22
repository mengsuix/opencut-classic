"""HyperFrames 特效渲染：agent 提交 HTML → 本机渲染 MP4 → 静态路由回传浏览器

链路：fx.render MCP 工具 → render_fx()（npx 固定版本 HyperFrames，无头 Chrome 逐帧捕获）
→ AGENT_DATA_DIR/fx/<session_id>/<job_id>/renders/*.mp4
→ GET /api/agent/sessions/{sid}/fx/{job_id}/{file_name}（api/fx.py，带会话归属校验）
→ 浏览器 media.import(url) 拉取入库。

产物约定为黑底视频，配合时间线 blendMode:"screen" 合成（黑底自动透明）。

已知边界：HTML 内的 JS 会在渲染机 Chrome 中执行并可访问网络（HyperFrames 模板
依赖 CDN），当前与 agent 同信任级，未做网络沙箱；如需多租户强隔离再加固。
"""

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path

from . import config

logger = logging.getLogger("agent-gateway.fx_render")

# 渲染吃满 CPU/内存，全局串行避免多会话并发渲染互相拖垮
_RENDER_SEMAPHORE = asyncio.Semaphore(1)

JOB_ID_RE = re.compile(r"^fx-\d+-[0-9a-f]{8}$")
OUTPUT_FILE_NAME_RE = re.compile(r"^[\w][\w.-]*\.(mp4|webm|png)$")

# 画布尺寸/时长读取自 HTML 的 HyperFrames 约定属性（root 元素上的 data-*）
_ATTR_RES = {
    "width": re.compile(r'data-width="(\d+)"'),
    "height": re.compile(r'data-height="(\d+)"'),
    "duration": re.compile(r'data-duration="([\d.]+)"'),
}
_ATTR_LIMITS = {
    "width": (256, 3840, 1920),
    "height": (256, 3840, 1080),
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


class FxRenderError(RuntimeError):
    """渲染失败（参数非法 / 渲染进程失败 / 无产物）"""


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


async def render_fx(session_id: str, html: str, *, format: str = "video") -> dict:
    """渲染一个特效 HTML，返回产物信息（路径/尺寸/时长/kind）

    format:
      "video" — HyperFrames render，黑底 MP4（配合 blendMode screen 使用）
      "image" — HyperFrames snapshot，透明背景 PNG（静态特效，直接作 image 元素）
    """
    if format not in ("video", "image"):
        raise FxRenderError(f"format 只支持 video/image（got {format!r}）")
    if not isinstance(html, str) or not html.strip():
        raise FxRenderError("html 不能为空")
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise FxRenderError(f"html 超过 {MAX_HTML_BYTES // 1024}KB 上限")
    width, height, duration = _parse_composition(html)

    job_id = f"fx-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    work_dir = config.AGENT_DATA_DIR / "fx" / session_id / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "index.html").write_text(html, encoding="utf-8")

    async with _RENDER_SEMAPHORE:
        if format == "image":
            stdout = await _run_snapshot(work_dir)
        else:
            stdout = await _run_render(work_dir)

    if format == "image":
        frames = sorted(
            (work_dir / "renders").glob("frame-*.png"),
            key=lambda p: p.stat().st_mtime,
        )
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

    outputs = sorted(
        (work_dir / "renders").glob("*.mp4"), key=lambda p: p.stat().st_mtime
    )
    if not outputs:
        tail = "\n".join(stdout.splitlines()[-15:])
        raise FxRenderError(f"渲染未产出视频文件。渲染日志尾部：\n{tail}")
    return {
        "jobId": job_id,
        "fileName": outputs[-1].name,
        "width": width,
        "height": height,
        "durationSeconds": duration,
        "kind": "video",
        "path": str(outputs[-1]),
    }


def _make_preview(src: Path, dest: Path) -> bool:
    """把渲染出的透明 PNG 做成给模型看的预览图：长边限幅 + 透明区铺浅色棋盘格。

    失败（缺 Pillow / 解码异常）返回 False，渲染产物本身照常返回，不因此报错。
    """
    try:
        from PIL import Image, ImageDraw

        with Image.open(src) as opened:
            img = opened.convert("RGBA")
        longest = max(img.size)
        if longest > PREVIEW_MAX_EDGE:
            scale = PREVIEW_MAX_EDGE / longest
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
                    draw.rectangle(
                        [x, y, x + cell - 1, y + cell - 1], fill=PREVIEW_DARK
                    )
        background.paste(img, (0, 0), img)
        background.save(dest, format="PNG", optimize=True)
        return True
    except Exception as e:
        logger.warning(f"预览图生成失败（渲染产物不受影响）: {type(e).__name__}: {e}")
        return False


async def _run_snapshot(work_dir: Path) -> str:
    """snapshot 截取 t=0 帧为 RGBA PNG（透明背景保留），秒级完成"""
    cmd = [
        "npx",
        "--yes",
        f"hyperframes@{config.FX_HYPERFRAMES_VERSION}",
        "snapshot",
        "--frames",
        "1",
        "--no-end",
        "--at",
        "0",
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
    text = stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        tail = "\n".join(text.splitlines()[-15:])
        raise FxRenderError(f"渲染进程失败（exit={proc.returncode}）：\n{tail}")
    return text


async def _run_render(work_dir: Path) -> str:
    cmd = [
        "npx",
        "--yes",
        f"hyperframes@{config.FX_HYPERFRAMES_VERSION}",
        "render",
        "--quiet",
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
    text = stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        tail = "\n".join(text.splitlines()[-15:])
        raise FxRenderError(f"渲染进程失败（exit={proc.returncode}）：\n{tail}")
    return text
