import json
import unittest
from unittest import mock

from app import editor_bridge
from app.agent_service import OPENCUT_MCP_TOOLS


class McpToolsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with mock.patch.object(
            editor_bridge, "create_sdk_mcp_server", side_effect=lambda **kwargs: kwargs
        ):
            server = editor_bridge.build_editor_mcp_server("test-session")
        self.tools = {tool.name: tool for tool in server["tools"]}

    def test_agent_tool_list_matches_registered_tools(self):
        self.assertEqual(
            set(OPENCUT_MCP_TOOLS),
            {f"mcp__opencut__{name}" for name in self.tools},
        )

    async def test_route_tool_passes_only_user_requirement(self):
        with mock.patch.object(
            editor_bridge.route_judge,
            "judge",
            new=mock.AsyncMock(return_value=("code_render", "PATH: code_render")),
        ) as judge:
            result = await self.tools["judge_route"].handler(
                {"requirement": " 指针扫过显示下一画面，保留原声 "}
            )
        judge.assert_awaited_once_with("指针扫过显示下一画面，保留原声")
        self.assertEqual(json.loads(result["content"][0]["text"])["path"], "code_render")

    async def test_route_tool_rejects_empty_requirement(self):
        result = await self.tools["judge_route"].handler({"requirement": " "})
        self.assertTrue(result["is_error"])

    async def test_frame_preview_does_not_force_video_delivery(self):
        rendered = {
            "jobId": "test-preview", "kind": "frames", "width": 1280,
            "height": 720, "durationSeconds": 1, "previewPaths": ["preview.png"],
        }
        with mock.patch.object(editor_bridge.Path, "read_bytes", return_value=b"png"), mock.patch.object(
            editor_bridge.fx_render, "render_fx", new=mock.AsyncMock(return_value=rendered)
        ) as render:
            result = await self.tools["add_media"].handler(
                {"html": "<!doctype html><html></html>", "format": "frames"}
            )
        self.assertEqual(render.await_args.kwargs["format"], "frames")
        next_step = json.loads(result["content"][0]["text"])["next"]
        self.assertIn("timeline.add_html", next_step)
        self.assertIn("只有已选定固定媒体素材", next_step)
        self.assertIn("实时 code_render", next_step)

    async def test_empty_or_unreadable_frame_preview_is_an_error(self):
        for paths in [[], ["missing-preview.png"]]:
            rendered = {
                "jobId": "test-preview", "kind": "frames", "width": 1280,
                "height": 720, "durationSeconds": 1, "previewPaths": paths,
            }
            with mock.patch.object(editor_bridge.fx_render, "render_fx", new=mock.AsyncMock(return_value=rendered)), mock.patch.object(editor_bridge.Path, "read_bytes", side_effect=OSError("missing")):
                result = await self.tools["add_media"].handler({"html": "<html></html>", "format": "frames"})
            self.assertTrue(result["is_error"])

    async def test_image_preview_can_deliver_live_html(self):
        rendered = {"jobId": "test-image", "kind": "image", "width": 1280, "height": 720, "durationSeconds": 1, "fileName": "preview.png", "previewPath": "preview.png"}
        with mock.patch.dict(editor_bridge._editor_base_urls, {"test-session": "http://localhost:8787"}), mock.patch.object(editor_bridge.Path, "read_bytes", return_value=b"png"), mock.patch.object(editor_bridge.fx_render, "render_fx", new=mock.AsyncMock(return_value=rendered)):
            result = await self.tools["add_media"].handler({"html": "<html></html>", "format": "image"})
        payload = json.loads(result["content"][0]["text"])
        self.assertIn("timeline.add_html", payload["next"])
        self.assertTrue(payload["imageHandles"])

    def test_pixel_tools_describe_the_live_render_path(self):
        self.assertIn("Canvas2D", self.tools["add_media"].description)
        self.assertIn("优先 code_render", self.tools["add_media"].description)
        self.assertIn("实时 code_render", self.tools["judge_visual"].description)


if __name__ == "__main__":
    unittest.main()
