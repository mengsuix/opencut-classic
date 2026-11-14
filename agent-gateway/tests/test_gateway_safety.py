import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from claude_agent_sdk import ResultMessage
from fastapi import HTTPException, WebSocketDisconnect

from app import editor_bridge, visual_judge
from app.agent_service import AgentService, _SessionState
from app.api import media


class FakeSocket:
    def __init__(self, session_id):
        self.query_params = {"session_id": session_id, "token": "test"}
        self.headers = {"host": "localhost:8787"}
        self.incoming = asyncio.Queue()
        self.accepted = asyncio.Event()

    async def accept(self):
        self.accepted.set()

    async def close(self, **kwargs):
        pass

    async def receive_text(self):
        message = await self.incoming.get()
        if message is None:
            raise WebSocketDisconnect()
        return json.dumps(message)


class GatewaySafetyTest(unittest.IsolatedAsyncioTestCase):
    def test_visual_pass_parsing_is_fail_closed(self):
        for text, expected in [
            ("PASS: true", True), ("PASS: TRUE\nREASON: fine", True),
            ("PASS: false — true only after fixes", False),
            ("PASS: truest", False), ("PASS: untrue", False),
            ("PASS:", False), ("REASON: true", False),
        ]:
            with self.subTest(text=text):
                self.assertIs(visual_judge._parse_pass(text), expected)

    async def test_only_request_owner_socket_can_complete_response(self):
        owner, other = FakeSocket("owner"), FakeSocket("other")
        with mock.patch.object(editor_bridge.auth, "resolve_user_id", new=mock.AsyncMock(return_value="user")), mock.patch.object(editor_bridge.db, "fetchval", new=mock.AsyncMock(return_value="user")):
            tasks = [asyncio.create_task(editor_bridge.editor_websocket_endpoint(ws)) for ws in [owner, other]]
            try:
                await owner.accepted.wait()
                await other.accepted.wait()
                future = asyncio.get_running_loop().create_future()
                timer = mock.Mock()
                editor_bridge._pending["test-owner-request"] = (future, timer, owner)
                await other.incoming.put({"type": "response", "id": "test-owner-request", "ok": True, "result": "wrong"})
                await asyncio.sleep(0)
                self.assertFalse(future.done())
                self.assertIn("test-owner-request", editor_bridge._pending)
                timer.cancel.assert_not_called()
                await owner.incoming.put({"type": "response", "id": "test-owner-request", "ok": True, "result": "correct"})
                self.assertEqual(await asyncio.wait_for(future, 1), "correct")
                timer.cancel.assert_called_once()
            finally:
                for ws in [owner, other]:
                    await ws.incoming.put(None)
                await asyncio.gather(*tasks)
                editor_bridge._pending.pop("test-owner-request", None)

    def _state(self):
        client = mock.MagicMock()
        client.interrupt = mock.AsyncMock()
        client.query = mock.AsyncMock()
        state = _SessionState(session_id="test", project_id="project", user_id="user", created_at=1, client=client, turn_open=True)
        state.change_log.append({"ok": True, "category": "modified"})
        service = AgentService()
        service._sessions[state.session_id] = state
        return service, state, client

    async def test_unfinished_previous_turn_blocks_new_query_on_timeout(self):
        service, state, client = self._state()
        clock = SimpleNamespace(time=mock.Mock(side_effect=[0, 21]))
        with mock.patch("app.agent_service.asyncio.get_running_loop", return_value=clock):
            events = [event async for event in service.send_message_stream("test", "new message")]
        client.interrupt.assert_awaited_once()
        client.query.assert_not_awaited()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].event, "error")
        self.assertTrue(events[0].data["recoverable"])
        self.assertEqual(state.turn_count, 0)
        self.assertTrue(state.turn_open)
        self.assertEqual(len(state.change_log), 1)

    async def test_finished_previous_turn_allows_next_query(self):
        service, state, client = self._state()
        def result():
            return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="test")
        state.messages.put_nowait(result())
        client.query.side_effect = lambda _: state.messages.put_nowait(result())
        events = [event async for event in service.send_message_stream("test", "new message")]
        client.query.assert_awaited_once_with("new message")
        self.assertEqual(events[-1].event, "result")
        self.assertEqual(state.turn_count, 1)

    async def test_upload_limit_stops_reading_without_writing(self):
        consumed = []
        async def stream():
            for chunk in [b"123", b"456", b"never read"]:
                consumed.append(chunk)
                yield chunk
        request = SimpleNamespace(headers={"content-type": "video/webm"}, stream=stream)
        with mock.patch.object(media, "MAX_UPLOAD_BYTES", 5), mock.patch.object(media, "resolve_user_id", new=mock.AsyncMock()), mock.patch.object(media, "_media_dir") as directory:
            with self.assertRaises(HTTPException) as error:
                await media.upload_media_window(request, "Bearer test")
        self.assertEqual(error.exception.status_code, 413)
        self.assertEqual(consumed, [b"123", b"456"])
        directory.assert_not_called()

    async def test_upload_within_limit_and_empty_upload(self):
        async def stream():
            yield b"123"
            yield b"45"
        request = SimpleNamespace(headers={"content-type": "video/webm"}, stream=stream)
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(media, "MAX_UPLOAD_BYTES", 5), mock.patch.object(media, "resolve_user_id", new=mock.AsyncMock()), mock.patch.object(media, "_media_dir", return_value=Path(folder)):
            result = await media.upload_media_window(request, "Bearer test")
            self.assertEqual((Path(folder) / result["fileName"]).read_bytes(), b"12345")
        async def empty_stream():
            yield b""
        request.stream = empty_stream
        with mock.patch.object(media, "resolve_user_id", new=mock.AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await media.upload_media_window(request, "Bearer test")
        self.assertEqual(error.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
