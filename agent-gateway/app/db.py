"""自有表存储层（agent_sessions / agent_messages）

支持两种后端，由 DATABASE_URL 的 scheme 决定：
- mysql://user:pass@host:port/dbname        — aiomysql（本地/线上，自动建库建表）
- postgres:// / postgresql://               — asyncpg（better_auth 共享库模式）

对调用方暴露统一的 fetch/fetchval/fetchrow/execute 接口，
SQL 统一写 asyncpg 风格的 $N 占位符，MySQL 后端自动转换为 %s。
"""

import re
from urllib.parse import unquote, urlparse

import aiomysql
import asyncpg

_backend: str | None = None  # "pg" | "mysql"
_pg_pool: asyncpg.Pool | None = None
_mysql_pool: aiomysql.Pool | None = None

_DDL_PG = """
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

_DDL_MYSQL = [
    """
    CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        project_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128) NOT NULL,
        created_at DOUBLE NOT NULL,
        last_activity DOUBLE NOT NULL,
        INDEX idx_user_project (user_id, project_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agent_messages (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        session_id VARCHAR(64) NOT NULL,
        role VARCHAR(16) NOT NULL,
        content TEXT NOT NULL,
        created_at DOUBLE NOT NULL,
        INDEX idx_session (session_id, created_at),
        FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
    )
    """,
]


def _mysql_connect_kwargs() -> tuple[dict, str]:
    parsed = urlparse(_database_url())
    dbname = parsed.path.lstrip("/")
    if not re.fullmatch(r"\w+", dbname):
        raise RuntimeError(f"DATABASE_URL 中的数据库名非法: {dbname!r}")
    kwargs = {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or "root"),
        "password": unquote(parsed.password or ""),
    }
    return kwargs, dbname


def _database_url() -> str:
    from . import config

    return config.DATABASE_URL


async def init_pool() -> None:
    global _backend, _pg_pool, _mysql_pool
    url = _database_url()
    if url.startswith(("postgres://", "postgresql://")):
        _backend = "pg"
        _pg_pool = await asyncpg.create_pool(url, min_size=1, max_size=5)
        async with _pg_pool.acquire() as conn:
            await conn.execute(_DDL_PG)
    elif url.startswith("mysql://"):
        _backend = "mysql"
        kwargs, dbname = _mysql_connect_kwargs()
        # 先不带库连接，自动建库
        conn = await aiomysql.connect(**kwargs)
        try:
            async with conn.cursor() as cur:
                await cur.execute(f"CREATE DATABASE IF NOT EXISTS `{dbname}`")
        finally:
            conn.close()
        _mysql_pool = await aiomysql.create_pool(
            **kwargs, db=dbname, minsize=1, maxsize=5, autocommit=True
        )
        async with _mysql_pool.acquire() as pool_conn:
            async with pool_conn.cursor() as cur:
                for stmt in _DDL_MYSQL:
                    await cur.execute(stmt)
    else:
        raise RuntimeError(
            "DATABASE_URL 未配置或 scheme 不支持（需要 mysql:// 或 postgres://）"
        )


async def close_pool() -> None:
    global _pg_pool, _mysql_pool
    if _pg_pool is not None:
        await _pg_pool.close()
        _pg_pool = None
    if _mysql_pool is not None:
        _mysql_pool.close()
        await _mysql_pool.wait_closed()
        _mysql_pool = None


def _check_ready() -> None:
    if _backend is None:
        raise RuntimeError("DB 未初始化")


def _to_mysql_args(query: str, args: tuple) -> tuple[str, tuple]:
    """$N 占位符展开为顺序 %s（PyMySQL 按位置消费，重复引用需重复传参）"""
    new_args: list = []

    def repl(match: re.Match) -> str:
        new_args.append(args[int(match.group(1)) - 1])
        return "%s"

    return re.sub(r"\$(\d+)", repl, query), tuple(new_args)


async def fetchval(query: str, *args):
    _check_ready()
    if _backend == "pg":
        async with _pg_pool.acquire() as conn:
            return await conn.fetchval(query, *args)
    async with _mysql_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(*_to_mysql_args(query, args))
            row = await cur.fetchone()
            return row[0] if row else None


async def fetchrow(query: str, *args):
    """返回 dict（MySQL）或 Record（PG），按下标/键访问"""
    _check_ready()
    if _backend == "pg":
        async with _pg_pool.acquire() as conn:
            return await conn.fetchrow(query, *args)
    async with _mysql_pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(*_to_mysql_args(query, args))
            return await cur.fetchone()


async def fetch(query: str, *args):
    _check_ready()
    if _backend == "pg":
        async with _pg_pool.acquire() as conn:
            return await conn.fetch(query, *args)
    async with _mysql_pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(*_to_mysql_args(query, args))
            return await cur.fetchall()


async def execute(query: str, *args):
    _check_ready()
    if _backend == "pg":
        async with _pg_pool.acquire() as conn:
            return await conn.execute(query, *args)
    async with _mysql_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(*_to_mysql_args(query, args))
