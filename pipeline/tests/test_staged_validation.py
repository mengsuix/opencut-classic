import json
import unittest

from pipeline.edit_plan import EDIT_STAGES, STAGE_SCHEMAS, _schema_errors
from pipeline.staged_validation import validate_artifact


class StagedValidationTests(unittest.TestCase):
    def test_each_stage_schema_rejects_missing_required_fields(self):
        for stage in EDIT_STAGES:
            with self.subTest(stage=stage):
                errors = _schema_errors(stage, {})
                self.assertTrue(any(error["code"] == "schema_required" for error in errors))

    def test_stage_schemas_are_strict_compliant(self):
        def walk(node, path, problems):
            if isinstance(node, dict):
                if "type" not in node and "$ref" not in node:
                    problems.append(f"{path or '$'}: 缺 type")
                if node.get("type") == "object" or "properties" in node:
                    if node.get("additionalProperties") is not False:
                        problems.append(f"{path or '$'}: additionalProperties 必须为 false")
                    properties = node.get("properties")
                    if isinstance(properties, dict) and sorted(node.get("required") or []) != sorted(properties.keys()):
                        problems.append(f"{path or '$'}: required 必须恰好包含 properties 的所有键")
                if node.get("type") == "array" and "items" not in node:
                    problems.append(f"{path or '$'}: 数组必须声明 items")
                for key, value in node.items():
                    if key == "properties" and isinstance(value, dict):
                        for prop, sub in value.items():
                            walk(sub, f"{path}.{prop}" if path else prop, problems)
                    else:
                        walk(value, f"{path}.{key}" if path else key, problems)
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{path}[{index}]", problems)

        for stage in EDIT_STAGES:
            with self.subTest(stage=stage):
                schema = json.loads(STAGE_SCHEMAS[stage].read_text(encoding="utf-8"))
                problems = []
                walk(schema, "", problems)
                self.assertEqual(problems, [], "tcodex 上游要求 OpenAI strict 结构化输出")

    def test_proposal_requires_grounded_concepts(self):
        errors = validate_artifact("proposal", _proposal())
        self.assertEqual(errors, [])

        proposal = _proposal()
        for concept in proposal["concept_options"]:
            concept["grounded_in"] = []
        errors = validate_artifact("proposal", proposal)
        self.assertTrue(any(error["path"].endswith("grounded_in") for error in errors))

        proposal = _proposal()
        proposal["concept_options"][0]["grounded_in"] = ["asset:ghost"]
        errors = validate_artifact("proposal", proposal)
        self.assertTrue(any(error["code"] == "unknown_asset_ref" for error in errors))

    def test_storyboard_valid(self):
        errors = validate_artifact("storyboard", _storyboard(), expected_duration=10)
        self.assertEqual(errors, [])

    def test_storyboard_rejects_speech_faster_than_shot_duration(self):
        value = _storyboard()
        value["shots"][0]["narration"] = "字" * 100
        errors = validate_artifact("storyboard", value, expected_duration=10)
        self.assertTrue(any(error["code"] == "speech_rate_infeasible" for error in errors))

    def test_storyboard_rejects_timeline_gap(self):
        value = _storyboard()
        value["shots"][1]["start_seconds"] = 6
        errors = validate_artifact("storyboard", value, expected_duration=10)
        self.assertTrue(any(error["code"] == "timeline_gap" for error in errors))

    def test_storyboard_rejects_duration_mismatch(self):
        errors = validate_artifact("storyboard", _storyboard(), expected_duration=30)
        self.assertTrue(any(error["code"] == "duration_mismatch" for error in errors))

    def test_storyboard_rejects_duplicate_shot_id(self):
        value = _storyboard()
        value["shots"][1]["id"] = "shot_001"
        errors = validate_artifact("storyboard", value, expected_duration=10)
        self.assertTrue(any(error["code"] == "duplicate" for error in errors))


def _concept(concept_id: str, grounded_in: list | None = None) -> dict:
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
        "grounded_in": ["requirement:制作产品视频"] if grounded_in is None else grounded_in,
        "why_this_works": "贴合需求",
    }


def _proposal() -> dict:
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


def _storyboard() -> dict:
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


if __name__ == "__main__":
    unittest.main()
