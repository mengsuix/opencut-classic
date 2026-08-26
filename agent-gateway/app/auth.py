"""鉴权：校验 better-auth session token（共享库直查 sessions 表）"""

from fastapi import HTTPException

from . import config, db


def bearer_token(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        return token or None
    return None


async def resolve_user_id(token: str | None) -> str:
    """解析 token → user_id。失败抛 HTTPException(401)。"""
    if config.DEV_BYPASS_AUTH:
        return "dev-user"
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    user_id = await db.fetchval(
        "SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()",
        token,
    )
    if not user_id:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return user_id
