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

    def test_edit_decisions_allow_overlay_over_primary_track(self):
        errors = validate_artifact(
            "edit_decisions",
            _edit_decisions(),
            asset_ids={"asset_0001"},
            scene_ids={"scene_01"},
            expected_duration=10,
            expected_renderer_family="screen-demo",
            expected_render_runtime="remotion",
        )
        self.assertEqual(errors, [])

    def test_edit_decisions_reject_invalid_source_range(self):
        value = _edit_decisions()
        value["cuts"][0]["out_seconds"] = 0
        errors = validate_artifact(
            "edit_decisions",
            value,
            asset_ids={"asset_0001"},
            scene_ids={"scene_01"},
            expected_duration=10,
            expected_renderer_family="screen-demo",
            expected_render_runtime="remotion",
        )
        self.assertTrue(any(error["code"] == "invalid_source_range" for error in errors))

    def test_edit_decisions_reject_unknown_scene(self):
        value = _edit_decisions()
        value["cuts"][0]["scene_id"] = "scene_missing"
        errors = validate_artifact(
            "edit_decisions",
            value,
            asset_ids={"asset_0001"},
            scene_ids={"scene_01"},
            expected_duration=10,
            expected_renderer_family="screen-demo",
            expected_render_runtime="remotion",
        )
        self.assertTrue(any(error["code"] == "unknown_scene_ref" for error in errors))

    def test_script_rejects_speech_faster_than_section_duration(self):
        errors = validate_artifact("script", _script("这是一段长度合适的旁白文本。"), asset_ids=set())
        self.assertEqual(errors, [])

        errors = validate_artifact("script", _script("字" * 100), asset_ids=set())
        self.assertTrue(any(error["code"] == "speech_rate_infeasible" for error in errors))

    def test_scene_plan_rejects_identical_visual_grammar(self):
        scenes = [_scene("s1", 0, 10), _scene("s2", 10, 20), _scene("s3", 20, 30), _scene("s4", 30, 40)]
        errors = validate_artifact(
            "scene_plan",
            _scene_plan(scenes),
            asset_ids=set(),
            expected_duration=40,
            script_section_ids={"sec_1"},
            supplemental_ids=set(),
        )
        self.assertTrue(any(error["code"] == "no_visual_variation" for error in errors))

        for index, scene in enumerate(scenes):
            scene["framing"] = f"构图{index}"
        errors = validate_artifact(
            "scene_plan",
            _scene_plan(scenes),
            asset_ids=set(),
            expected_duration=40,
            script_section_ids={"sec_1"},
            supplemental_ids=set(),
        )
        self.assertEqual(errors, [])

    def test_proposal_requires_grounded_concepts(self):
        errors = validate_artifact("proposal", _proposal(), asset_ids=set())
        self.assertEqual(errors, [])

        proposal = _proposal()
        for concept in proposal["concept_options"]:
            concept["grounded_in"] = []
        errors = validate_artifact("proposal", proposal, asset_ids=set())
        self.assertTrue(any(error["path"].endswith("grounded_in") for error in errors))

        proposal = _proposal()
        proposal["concept_options"][0]["grounded_in"] = ["asset:ghost"]
        errors = validate_artifact("proposal", proposal, asset_ids=set())
        self.assertTrue(any(error["code"] == "unknown_asset_ref" for error in errors))


def _script(text: str) -> dict:
    return {
        "version": "1.0",
        "title": "测试脚本",
        "total_duration_seconds": 10,
        "voice_performance": {
            "performance_intent": "清晰",
            "pacing_profile": "conversational",
            "energy_curve": "平稳",
            "pause_policy": "句号停顿",
            "sample_section_id": "",
            "provider_notes": {"provider": "", "voice": "", "notes": ""},
        },
        "sections": [
            {
                "id": "sec_1",
                "label": "开场",
                "text": text,
                "start_seconds": 0,
                "end_seconds": 10,
                "speaker_directions": "",
                "delivery_cues": {"pace": "", "emphasis": "", "notes": ""},
                "enhancement_cues": [],
                "source_basis": "需求",
                "source_ref": "",
                "pronunciation_guides": [],
            }
        ],
        "factual_notes": [],
        "assumptions": [],
        "risks": [],
    }


def _scene(scene_id: str, start: int, end: int) -> dict:
    return {
        "id": scene_id,
        "type": "screen_recording",
        "description": "演示画面",
        "start_seconds": start,
        "end_seconds": end,
        "script_section_id": "sec_1",
        "framing": "全景",
        "movement": "静止",
        "transition_in": "无",
        "transition_out": "无",
        "shot_intent": "展示功能",
        "narrative_role": "establish_context",
        "information_role": "功能信息",
        "hero_moment": False,
        "required_assets": [],
        "shot_language": {"shot_size": "", "camera_angle": "", "notes": ""},
        "overlay_notes": "",
    }


def _scene_plan(scenes: list) -> dict:
    return {
        "version": "1.0",
        "style_playbook": "clean-professional",
        "scenes": scenes,
        "metadata": {"crop_regions": [], "callout_plan": [], "speed_plan": [], "quality_gates": ["检查时间线"]},
        "assumptions": [],
        "risks": [],
    }


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


def _edit_decisions() -> dict:
    return {
        "version": "1.0",
        "renderer_family": "screen-demo",
        "render_runtime": "remotion",
        "delivery_promise": "输出可供人工审核的屏幕演示剪辑方案",
        "cuts": [
            {
                "id": "cut_01",
                "scene_id": "scene_01",
                "source_type": "provided",
                "source": "asset_0001",
                "in_seconds": 0,
                "out_seconds": 10,
                "timeline_start": 0,
                "timeline_end": 10,
                "speed": 1,
                "layer": "primary",
                "transform": {"scale": None, "position": "", "notes": ""},
                "transition_in": "none",
                "transition_out": "none",
                "transition_duration": 0,
                "reason": "保持主画面连续",
            },
            {
                "id": "cut_02",
                "scene_id": "scene_01",
                "source_type": "provided",
                "source": "asset_0001",
                "in_seconds": 2,
                "out_seconds": 4,
                "timeline_start": 2,
                "timeline_end": 4,
                "speed": 1,
                "layer": "overlay",
                "transform": {"scale": 1.5, "position": "", "notes": ""},
                "transition_in": "fade",
                "transition_out": "fade",
                "transition_duration": 0,
                "reason": "局部放大关键区域",
            },
        ],
        "overlays": [],
        "audio": {"narration": "", "music": "", "sound_effects": "", "ducking": ""},
        "subtitles": {"style": "", "position": "", "notes": ""},
        "transitions": [],
        "end_card": {"headline": "", "subheadline": "", "cta": "", "visual": "", "audio": ""},
        "assumptions": [],
        "risks": [],
        "metadata": {
            "crop_keyframes": [],
            "speed_plan": [],
            "subtitle_position_overrides": [],
            "audio_notes": [],
            "variant_notes": [],
            "quality_gates": ["检查主轨连续性"],
        },
    }


if __name__ == "__main__":
    unittest.main()
