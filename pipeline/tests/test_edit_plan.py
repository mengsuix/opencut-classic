import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline.edit_plan import EditPlanInputError, run_edit_plan
from pipeline.tcodex import TcodexResult


class EditPlanTests(unittest.TestCase):
    def test_requirements_are_required(self):
        with self.assertRaises(EditPlanInputError):
            run_edit_plan()

    def test_end_to_end_writes_only_storyboard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requirements = root / "requirements.txt"
            requirements.write_text("制作一条产品视频。", encoding="utf-8")
            output_dir = root / "out"
            output_dir.mkdir()
            (output_dir / "video-plan.json").write_text("old", encoding="utf-8")
            (output_dir / "storyboard.json").write_text("old", encoding="utf-8")
            (output_dir / ".edit-plan" / "stages").mkdir(parents=True)
            (output_dir / ".edit-plan" / "stages" / "proposal.json").write_text("old", encoding="utf-8")

            with mock.patch("pipeline.edit_plan.TcodexClient", _FakeTcodexClient):
                summary = run_edit_plan(requirements=requirements, output_dir=output_dir)

            self.assertEqual(summary["status"], "succeeded")
            self.assertEqual(summary["completed_stages"], ["proposal", "storyboard"])
            self.assertEqual(summary["output_files"], ["storyboard.json"])
            self.assertEqual(list(output_dir.iterdir()), [output_dir / "storyboard.json"])


class _FakeTcodexClient:
    def __init__(self, *, cwd, schema_path, timeout=600, executable=None):
        self.schema_path = Path(schema_path)

    def run(self, prompt, *, session_id=None, search=False):
        stage = self.schema_path.stem
        return TcodexResult(
            exit_code=0,
            session_id=session_id or f"session-{stage}",
            text=json.dumps(_stage_artifact(stage), ensure_ascii=False),
            stdout="",
            stderr="",
            error_events=[],
        )


def _concept(concept_id: str) -> dict:
    return {
        "id": concept_id,
        "title": f"方向 {concept_id}",
        "hook": "开场钩子",
        "narrative_structure": "problem_solution",
        "visual_approach": "屏幕演示",
        "suggested_playbook": "",
        "target_audience": "",
        "target_platform": "",
        "target_duration_seconds": 10,
        "key_points": ["要点一", "要点二"],
        "core_message": "核心信息",
        "cta": "立即体验",
        "tone": "",
        "grounded_in": ["requirement:制作产品视频"],
        "why_this_works": "贴合需求",
    }


def _stage_artifact(stage: str) -> dict:
    if stage == "proposal":
        return {
            "version": "1.0",
            "concept_options": [_concept("c1"), _concept("c2"), _concept("c3")],
            "selected_concept": {"concept_id": "c1", "rationale": "最贴合需求", "modifications": []},
            "production_plan": {
                "pipeline": "edit-plan",
                "playbook": "",
                "stages": [{"stage": "compose", "tools": [], "approach": "按方案执行", "fallback_if_unavailable": ""}],
                "renderer_family": "screen-demo",
                "render_runtime": "remotion",
                "delivery_promise": {
                    "promise_type": "信息清晰",
                    "motion_required": False,
                    "source_required": False,
                    "tone_mode": "专业",
                    "quality_floor": "可读",
                    "approved_fallback": None,
                },
                "quality_tradeoffs": [],
                "alternative_paths": [],
            },
            "cost_estimate": {
                "total_estimated_usd": 0,
                "line_items": [],
                "budget_cap_usd": None,
                "budget_verdict": "no_budget_set",
                "savings_options": [],
            },
            "approval": {"status": "pending", "user_notes": "", "approved_budget_usd": None},
            "format": {"platform": "通用", "aspect_ratio": "16:9", "delivery_notes": ""},
            "creative_direction": {"labels": [], "description": ""},
            "assumptions": [],
            "risks": [],
        }
    if stage == "storyboard":
        return {
            "version": "1.0",
            "title": "测试视频",
            "objective": "让观众理解核心价值",
            "audience": "潜在用户",
            "concept_summary": "方向 c1",
            "format": {"platform": "通用", "aspect_ratio": "16:9", "delivery_notes": ""},
            "total_duration_seconds": 10,
            "cover": {"concept": "结果画面", "text_overlay": "测试视频", "reason": "首帧传达结果"},
            "shots": [
                {
                    "id": "shot_001",
                    "start_seconds": 0,
                    "end_seconds": 5,
                    "label": "开场钩子",
                    "visual": "结果画面特写",
                    "narration": "先看结果。",
                    "subtitle": "先看结果",
                    "asset_need": "录制一段真实生成结果",
                    "notes": "",
                },
                {
                    "id": "shot_002",
                    "start_seconds": 5,
                    "end_seconds": 10,
                    "label": "品牌收尾",
                    "visual": "品牌卡",
                    "narration": "",
                    "subtitle": "立即体验",
                    "asset_need": "品牌素材",
                    "notes": "",
                },
            ],
            "audio_notes": "轻快背景音乐",
            "assumptions": [],
            "risks": [],
        }
    raise AssertionError(f"未知阶段：{stage}")


if __name__ == "__main__":
    unittest.main()
