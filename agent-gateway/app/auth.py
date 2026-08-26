"""鉴权 provider：token → user_id

当前实现（AUTH_MODE 选择）：
- dev         — 直通，所有请求视为同一本地用户（默认，本地开发零依赖）
- better_auth — 查 apps/web better-auth 的 PG sessions 表（过渡方案，apps/web 现状）

接入自己的鉴权：新增一个 provider 函数（如 JWT 本地验签、查自己的用户表、
调自己的鉴权服务），在 resolve_user_id 中按 AUTH_MODE 分发即可。
WS / REST 两层都只依赖 resolve_user_id，无其他耦合点。
"""

from fastapi import HTTPException

from . import config, db

DEV_USER_ID = "dev-user"


def bearer_token(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        return token or None
    return None


async def _resolve_better_auth(token: str | None) -> str:
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    user_id = await db.fetchval(
        "SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()",
        token,
    )
    if not user_id:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return user_id


async def resolve_user_id(token: str | None) -> str:
    """解析 token → user_id。失败抛 HTTPException(401)。"""
    if config.AUTH_MODE == "dev":
        return DEV_USER_ID
    if config.AUTH_MODE == "better_auth":
        return await _resolve_better_auth(token)
    raise HTTPException(
        status_code=500, detail=f"未知的鉴权模式: {config.AUTH_MODE}"
    )
