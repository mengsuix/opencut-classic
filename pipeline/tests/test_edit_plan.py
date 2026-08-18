import tempfile
import unittest
from pathlib import Path

from pipeline.edit_plan import EditPlanInputError, build_agent_prompt, run_edit_plan, scan_directory
from pipeline.validation import validate_edit_plan


class EditPlanTests(unittest.TestCase):
    def test_requirements_are_required(self):
        with self.assertRaises(EditPlanInputError):
            run_edit_plan()

    def test_scan_keeps_unknown_formats_and_excludes_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "nested" / "demo.MP4").write_bytes(b"not really a video")
            (root / "notes.anything").write_bytes(b"arbitrary")
            output = root / "generated"
            output.mkdir()
            (output / "old.json").write_text("{}", encoding="utf-8")
            (root / ".hidden.txt").write_text("hidden", encoding="utf-8")

            manifest = scan_directory(root, excluded_dir=output.resolve())

            paths = {asset["path"] for asset in manifest["assets"]}
            self.assertEqual(paths, {"nested/demo.MP4", "notes.anything"})
            self.assertEqual(manifest["summary"]["asset_count"], 2)
            self.assertIn("unknown", {asset["kind"] for asset in manifest["assets"]})
            self.assertNotIn("generated/old.json", paths)
            self.assertTrue(any(item["reason"] == "hidden_path" for item in manifest["skipped"]))

    def test_empty_directory_is_valid_reference_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = scan_directory(Path(temporary))

            self.assertEqual(manifest["assets"], [])
            self.assertEqual(manifest["summary"]["asset_count"], 0)
            prompt = build_agent_prompt(manifest, "", "阶段规则", max_bytes=5000)
            self.assertIn("没有提供任何已有参考素材", prompt)

    def test_prompt_reports_truncation_without_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(50):
                (root / f"{'x' * 100}_{index}.unknown").write_bytes(b"x")
            manifest = scan_directory(root)
            prompt = build_agent_prompt(
                manifest,
                "请制作一条产品介绍视频。",
                "阶段规则",
                max_bytes=5000,
            )

            self.assertLessEqual(len(prompt.encode("utf-8")), 5000)
            self.assertIn('"manifest_truncated": true', prompt)
            self.assertNotIn(str(root), prompt)

    def test_valid_plan_references_only_known_assets(self):
        plan = _valid_plan()
        self.assertEqual(validate_edit_plan(plan, asset_ids={"asset_0001"}), [])

        plan["scenes"][0]["asset_refs"] = ["asset_missing"]
        errors = validate_edit_plan(plan, asset_ids={"asset_0001"})
        self.assertTrue(any(error["code"] == "unknown_asset_ref" for error in errors))

    def test_plan_requires_continuous_timeline(self):
        plan = _valid_plan()
        plan["scenes"][0]["start_sec"] = 1
        errors = validate_edit_plan(plan, asset_ids={"asset_0001"})
        self.assertTrue(any(error["code"] == "timeline_gap" for error in errors))


def _valid_plan() -> dict:
    return {
        "schema_version": "1.0",
        "title": "产品演示",
        "objective": "让观众理解核心价值",
        "audience": "潜在用户",
        "format": {
            "platform": "短视频",
            "aspect_ratio": "16:9",
            "delivery_notes": "高清导出",
        },
        "style": {"labels": ["清晰"], "description": "简洁有力"},
        "cover": {
            "source": "provided_asset",
            "asset_refs": ["asset_0001"],
            "supplemental_asset_refs": [],
            "visual_description": "使用关键结果画面",
            "headline": "更快完成任务",
            "subheadline": "产品演示",
            "layout": "主体居中",
            "treatment": "加深对比度",
            "reason": "首帧即可传达结果",
        },
        "target_duration_sec": 10,
        "scenes": [
            {
                "scene_id": "scene_01",
                "start_sec": 0,
                "end_sec": 10,
                "purpose": "展示结果并引导行动",
                "visual": "展示结果画面",
                "camera_motion": "轻微推近",
                "asset_refs": ["asset_0001"],
                "supplemental_asset_refs": [],
                "source_ranges": [
                    {
                        "asset_ref": "asset_0001",
                        "source_start_sec": 0,
                        "source_end_sec": 10,
                        "selection_reason": "包含完整结果",
                    }
                ],
                "on_screen_text": [{"text": "立即体验", "style": "粗体", "position": "中央"}],
                "narration": "这是一个简洁的产品演示。",
                "transition": "无",
                "emphasis": "高亮结果区域",
                "audio": {
                    "narration_treatment": "清晰旁白",
                    "music": "轻快低音量",
                    "sound_effects": [],
                    "mix_notes": "旁白时压低音乐",
                },
            }
        ],
        "voiceover": {
            "enabled": True,
            "language": "中文",
            "tone": "自然",
            "segments": [{"start_sec": 0, "end_sec": 4, "text": "这是一个简洁的产品演示。"}],
        },
        "captions": {
            "enabled": True,
            "source": "voiceover",
            "style": "白字黑边",
            "position": "底部安全区",
            "max_chars_per_line": 18,
        },
        "music": {
            "required": True,
            "mood": "轻快",
            "source": "补充音乐",
            "ducking_db": -12,
            "notes": "旁白期间降低音量",
        },
        "supplemental_assets": [],
        "end_card": {
            "start_sec": 8,
            "duration_sec": 2,
            "headline": "立即体验",
            "subheadline": "",
            "cta": "开始使用",
            "visual": "品牌色背景",
            "asset_refs": [],
            "supplemental_asset_refs": [],
            "audio": "音乐自然收尾",
        },
        "assumptions": [],
        "risks": [],
    }


if __name__ == "__main__":
    unittest.main()
