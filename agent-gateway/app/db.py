"""共享 Postgres 访问层（asyncpg）

只持有两张 Gateway 自有表（agent_sessions / agent_messages），
better-auth 的 sessions 表只读用于鉴权。
"""

import asyncpg

_pool: asyncpg.Pool | None = None

_DDL = """
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    last_activity DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_project
    ON agent_sessions(user_id, project_id);
CREATE TABLE IF NOT EXISTS agent_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session
    ON agent_messages(session_id, created_at);
"""


async def init_pool(database_url: str) -> None:
    global _pool
    _pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        await conn.execute(_DDL)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool 未初始化")
    return _pool


async def fetchval(query: str, *args):
    async with pool().acquire() as conn:
        return await conn.fetchval(query, *args)


async def fetchrow(query: str, *args):
    async with pool().acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetch(query: str, *args):
    async with pool().acquire() as conn:
        return await conn.fetch(query, *args)


async def execute(query: str, *args):
    async with pool().acquire() as conn:
        return await conn.execute(query, *args)
