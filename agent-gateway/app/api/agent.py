"""Agent REST API

- POST   /sessions                      — 打开（或恢复）项目的 Agent 会话，返回历史
- POST   /sessions/{id}/messages        — 发送消息（SSE 流式响应）
- POST   /sessions/{id}/interrupt       — 打断当前回复
- GET    /sessions/{id}/history         — 获取对话历史
- DELETE /sessions/{id}                 — 关闭会话（新建对话前端先删旧会话）
"""

import time
import uuid

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..agent_service import agent_service
from ..auth import bearer_token, resolve_user_id

router = APIRouter()


class OpenSessionRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    force_new: bool = False


class SendMessageRequest(BaseModel):
    message: str = Field(..., min_length=1)


async def _session_history(session_id: str) -> list[dict]:
    rows = await db.fetch(
        "SELECT role, content, created_at FROM agent_messages "
        "WHERE session_id = $1 ORDER BY created_at, id",
        session_id,
    )
    return [dict(r) for r in rows]


async def _get_owned_session(session_id: str, user_id: str):
    row = await db.fetchrow(
        "SELECT session_id, project_id, user_id FROM agent_sessions WHERE session_id = $1",
        session_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="会话不存在")
    if row["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="无权访问该会话")
    return row


@router.post("/sessions")
async def open_session(
    req: OpenSessionRequest, authorization: str | None = Header(None)
):
    """打开项目的 Agent 会话：一个项目一个活跃会话，重复打开恢复同一会话"""
    user_id = await resolve_user_id(bearer_token(authorization))
    now = time.time()

    if req.force_new:
        old = await db.fetchrow(
            "SELECT session_id FROM agent_sessions WHERE user_id = $1 AND project_id = $2",
            user_id,
            req.project_id,
        )
        if old:
            await agent_service.close_session(old["session_id"])
            await db.execute(
                "DELETE FROM agent_sessions WHERE session_id = $1", old["session_id"]
            )

    row = await db.fetchrow(
        "SELECT session_id FROM agent_sessions WHERE user_id = $1 AND project_id = $2",
        user_id,
        req.project_id,
    )

    if row:
        session_id = row["session_id"]
        info = agent_service.get_session_info(session_id)
        if not info or not info.is_active:
            has_history = (
                await db.fetchval(
                    "SELECT 1 FROM agent_messages WHERE session_id = $1 LIMIT 1",
                    session_id,
                )
                is not None
            )
            await agent_service.create_session(
                session_id=session_id,
                project_id=req.project_id,
                user_id=user_id,
                resume=has_history,
            )
    else:
        session_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO agent_sessions (session_id, project_id, user_id, created_at, last_activity) "
            "VALUES ($1, $2, $3, $4, $4)",
            session_id,
            req.project_id,
            user_id,
            now,
        )
        try:
            await agent_service.create_session(
                session_id=session_id,
                project_id=req.project_id,
                user_id=user_id,
                resume=False,
            )
        except Exception:
            await db.execute(
                "DELETE FROM agent_sessions WHERE session_id = $1", session_id
            )
            raise HTTPException(status_code=500, detail="创建 Agent 会话失败，请稍后重试")

    await db.execute(
        "UPDATE agent_sessions SET last_activity = $2 WHERE session_id = $1",
        session_id,
        now,
    )
    return {"session_id": session_id, "history": await _session_history(session_id)}


@router.post("/sessions/{session_id}/messages")
async def send_message_stream(
    session_id: str,
    req: SendMessageRequest,
    authorization: str | None = Header(None),
):
    """
    SSE 事件：
    - text: {"text": "..."}
    - thinking: {"thinking": "..."}
    - tool_use: {"tool": "execute_command", "summary": "timeline.split_elements"}
    - result: {"cost_usd": ..., "turn_number": ..., "interrupted": bool}
    - error: {"error": "..."}
    """
    user_id = await resolve_user_id(bearer_token(authorization))
    await _get_owned_session(session_id, user_id)

    async def event_generator():
        reply_parts: list[str] = []
        user_timestamp = time.time()
        async for event in agent_service.send_message_stream(session_id, req.message):
            if event.event == "text" and "text" in event.data:
                reply_parts.append(event.data["text"])
            elif event.event == "result":
                try:
                    await db.execute(
                        "INSERT INTO agent_messages (session_id, role, content, created_at) "
                        "VALUES ($1, 'user', $2, $3)",
                        session_id,
                        req.message,
                        user_timestamp,
                    )
                    await db.execute(
                        "INSERT INTO agent_messages (session_id, role, content, created_at) "
                        "VALUES ($1, 'assistant', $2, $3)",
                        session_id,
                        "".join(reply_parts),
                        time.time(),
                    )
                    await db.execute(
                        "UPDATE agent_sessions SET last_activity = $2 WHERE session_id = $1",
                        session_id,
                        time.time(),
                    )
                except Exception:
                    pass
            yield event.to_sse()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/sessions/{session_id}/interrupt")
async def interrupt_session(session_id: str, authorization: str | None = Header(None)):
    user_id = await resolve_user_id(bearer_token(authorization))
    await _get_owned_session(session_id, user_id)
    ok = await agent_service.interrupt_session(session_id)
    return {"status": "ok" if ok else "noop", "interrupted": ok}


@router.get("/sessions/{session_id}/history")
async def get_history(session_id: str, authorization: str | None = Header(None)):
    user_id = await resolve_user_id(bearer_token(authorization))
    await _get_owned_session(session_id, user_id)
    return {"history": await _session_history(session_id)}


@router.delete("/sessions/{session_id}")
async def close_session(session_id: str, authorization: str | None = Header(None)):
    user_id = await resolve_user_id(bearer_token(authorization))
    await _get_owned_session(session_id, user_id)
    await agent_service.close_session(session_id)
    await db.execute("DELETE FROM agent_sessions WHERE session_id = $1", session_id)
    return {"status": "ok"}
