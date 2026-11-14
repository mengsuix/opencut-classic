import unittest
from types import SimpleNamespace
from unittest import mock

from app import route_judge


def _response(text):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))]
    )


class RouteJudgeTest(unittest.IsolatedAsyncioTestCase):
    def _client(self, text):
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(return_value=_response(text))
        client.close = mock.AsyncMock()
        return client

    async def test_selects_path_from_requirement_without_preselection(self):
        requirement = "把 21 秒处的转场换成转盘转动，两个画面在转场中都要连续运动"
        client = self._client(
            "PATH: code_render\nREASON: 双画面转场可由实时 Canvas2D 合成。"
        )
        with mock.patch.object(route_judge, "AsyncOpenAI", return_value=client):
            path, verdict = await route_judge.judge(requirement)

        self.assertEqual(path, "code_render")
        self.assertIn("PATH: code_render", verdict)
        request = client.chat.completions.create.await_args.kwargs
        self.assertEqual(request["messages"][0]["role"], "system")
        user_content = request["messages"][1]["content"]
        self.assertIn(requirement, user_content)
        self.assertNotIn("拟选方案", user_content)
        client.close.assert_awaited_once()

    async def test_rejects_missing_path(self):
        client = self._client("REASON: 没有按协议返回路径")
        with mock.patch.object(route_judge, "AsyncOpenAI", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "未按协议返回 PATH"):
                await route_judge.judge("做一个霓虹角标")
        client.close.assert_awaited_once()

    async def test_rejects_unknown_path(self):
        client = self._client("PATH: guess\nREASON: 无效路径")
        with mock.patch.object(route_judge, "AsyncOpenAI", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "未知路径"):
                await route_judge.judge("做一个霓虹角标")
        client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
