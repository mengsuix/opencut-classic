"""特效渲染产物下载：GET /sessions/{session_id}/fx/{job_id}/{file_name}

供浏览器 media.import(url) 拉取 agent 渲染的特效视频。
鉴权与会话归属校验同 api/agent.py；job_id/file_name 白名单校验防路径穿越。
"""

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse

from .. import config, db
from ..auth import bearer_token, resolve_user_id
from ..fx_render import JOB_ID_RE, OUTPUT_FILE_NAME_RE

router = APIRouter()


@router.get("/sessions/{session_id}/fx/{job_id}/{file_name}")
async def get_fx_artifact(
    session_id: str,
    job_id: str,
    file_name: str,
    authorization: str | None = Header(None),
):
    user_id = await resolve_user_id(bearer_token(authorization))
    owner = await db.fetchval(
        "SELECT user_id FROM agent_sessions WHERE session_id = $1", session_id
    )
    if owner is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if owner != user_id:
        raise HTTPException(status_code=403, detail="无权访问该会话")
    if not JOB_ID_RE.fullmatch(job_id) or not OUTPUT_FILE_NAME_RE.fullmatch(file_name):
        raise HTTPException(status_code=404, detail="产物不存在")
    renders_dir = (
        config.AGENT_DATA_DIR / "fx" / session_id / job_id / "renders"
    ).resolve()
    path = (renders_dir / file_name).resolve()
    if path.parent != renders_dir or not path.is_file():
        raise HTTPException(status_code=404, detail="产物不存在")
    media_type = "video/webm" if path.suffix == ".webm" else "video/mp4"
    return FileResponse(path, media_type=media_type, filename=file_name)
