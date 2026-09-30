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
      "frames" — HyperFrames snapshot 多时间点关键帧（动态特效的秒级预览，
                 多轮迭代确认效果后再用 "video" 正式渲染）
    """
    if format not in ("video", "image", "frames"):
        raise FxRenderError(f"format 只支持 video/image/frames（got {format!r}）")
    if not isinstance(html, str) or not html.strip():
        raise FxRenderError("html 不能为空")
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise FxRenderError(f"html 超过 {MAX_HTML_BYTES // 1024}KB 上限")
    width, height, duration = _parse_composition(html)

    job_id = f"fx-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    work_dir = config.AGENT_DATA_DIR / "fx" / session_id / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "index.html").write_text(html, encoding="utf-8")

    if format == "video":
        async with _RENDER_SEMAPHORE:
            stdout = await _run_render(work_dir)
    else:
        at = "0" if format == "image" else _frames_timestamps(duration)
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


def _frames_timestamps(duration: float) -> str:
    """动态特效预览的抽帧时间点（逗号分隔）：0.2/0.5/0.8 倍时长，
    覆盖入场中段、动画中间态与接近稳态，避开 t=0（常为入场前空白）与末尾。"""
    return ",".join(f"{duration * f:.2f}" for f in (0.2, 0.5, 0.8))


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
