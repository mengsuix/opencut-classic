"""Agent Gateway 应用入口

注意：必须以单 worker 运行（uvicorn --workers 1）。
Claude SDK 子进程状态在内存 _sessions 字典中，多 worker 会导致会话错乱。
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, db
from .agent_service import agent_service
from .api.agent import router as agent_router
from .editor_bridge import editor_websocket_endpoint

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("agent-gateway")


async def _idle_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(config.IDLE_CLEANUP_INTERVAL_SECONDS)
        try:
            cleaned = await agent_service.cleanup_idle_sessions(
                config.IDLE_SESSION_SECONDS
            )
            if cleaned:
                logger.info(f"空闲 session 清理完成: {cleaned} 个")
        except Exception as e:
            logger.error(f"空闲 session 清理失败: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL 未配置")
    config.AGENT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    await db.init_pool(config.DATABASE_URL)
    cleanup_task = asyncio.create_task(_idle_cleanup_loop())
    logger.info(
        f"Agent Gateway 已启动 (port={config.GATEWAY_PORT}, model={config.AGENT_MODEL}, "
        f"dev_bypass_auth={config.DEV_BYPASS_AUTH})"
    )
    yield
    cleanup_task.cancel()
    await agent_service.close_all_sessions()
    await db.close_pool()


app = FastAPI(title="OpenCut Agent Gateway", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.WEB_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router, prefix="/api/agent")
app.websocket("/ws/editor")(editor_websocket_endpoint)


@app.get("/health")
async def health():
    return {"status": "ok"}
