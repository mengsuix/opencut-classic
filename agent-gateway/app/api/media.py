"""转场烘焙素材窗口段的上传/下载：POST /media + GET /media/{file_name}

media.supply_window 桥命令把素材的一个时间窗口（转场点前后 ≤几秒）在浏览器里
转码成小 WebM 后 POST 到这里；add_media 的 HTML 里 <video src="该 URL"> 由渲染机
Chrome（与 gateway 同机）拉取全帧率烘焙。

安全模型：
- 上传要求 Bearer 鉴权（同 api/agent.py），任意大小/扩展名不接收。
- 下载免鉴权：渲染机 <video> 无法带 Authorization 头。文件名是含时间戳的
  uuid（不可枚举），文件按 MEDIA_ARTIFACT_TTL_SECONDS 定期清理，且 GATEWAY_HOST
  默认仅监听 127.0.0.1 不暴露公网。URL 只在会话内的 add_media HTML 里流动，
  与 fx 产物"当前与 agent 同信任级"的模型一致。
"""

import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

from .. import config
from ..auth import bearer_token, resolve_user_id

router = APIRouter()

# 文件名内嵌创建时间戳便于 TTL 清理（同 fx 产物 JOB_ID_RE 模式）
MEDIA_FILE_NAME_RE = re.compile(r"^m-\d+-[0-9a-f]{8}\.(webm|mp4)$")
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
CONTENT_TYPE_EXTS = {
    "video/webm": ".webm",
    "video/mp4": ".mp4",
}


def _media_dir() -> Path:
    directory = config.AGENT_DATA_DIR / "media"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@router.post("/media")
async def upload_media_window(request: Request, authorization: str | None = Header(None)):
    await resolve_user_id(bearer_token(authorization))
    ext = CONTENT_TYPE_EXTS.get(request.headers.get("content-type", ""))
    if ext is None:
        raise HTTPException(status_code=415, detail="仅支持 video/webm 或 video/mp4")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="空上传")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="超过 64MB 上限")
    file_name = f"m-{int(time.time())}-{uuid.uuid4().hex[:8]}{ext}"
    (_media_dir() / file_name).write_bytes(body)
    base_url = config.MEDIA_INTERNAL_BASE_URL or f"http://127.0.0.1:{config.GATEWAY_PORT}"
    return {
        "url": f"{base_url}/api/agent/media/{file_name}",
        "fileName": file_name,
    }


@router.get("/media/{file_name}")
async def get_media_window(file_name: str):
    if not MEDIA_FILE_NAME_RE.fullmatch(file_name):
        raise HTTPException(status_code=404, detail="产物不存在")
    media_dir = _media_dir().resolve()
    path = (media_dir / file_name).resolve()
    if path.parent != media_dir or not path.is_file():
        raise HTTPException(status_code=404, detail="产物不存在")
    media_type = "video/webm" if path.suffix == ".webm" else "video/mp4"
    # 无需 CORS 头：渲染机帧提取走 FFmpeg（不受 CORS 约束），页面侧 media 加载
    # 也是 no-cors（且框架 lint 禁止 <video crossorigin>）。
    return FileResponse(path, media_type=media_type, filename=file_name)


def cleanup_media_artifacts(max_age_seconds: float, now: float | None = None) -> int:
    """删除超过 max_age_seconds 的素材窗口段（data/media/），返回删除数"""
    media_dir = config.AGENT_DATA_DIR / "media"
    if not media_dir.is_dir():
        return 0
    cutoff = (now if now is not None else time.time()) - max_age_seconds
    removed = 0
    for path in media_dir.iterdir():
        match = MEDIA_FILE_NAME_RE.match(path.name)
        if not match or int(match.group(1)) >= cutoff:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            continue
    return removed
