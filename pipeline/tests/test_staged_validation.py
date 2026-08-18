import unittest

from pipeline.edit_plan import _schema_errors
from pipeline.staged_validation import validate_artifact


class StagedValidationTests(unittest.TestCase):
    def test_each_stage_schema_rejects_missing_required_fields(self):
        for stage in ["source_media_review", "proposal", "script", "scene_plan", "asset_plan", "edit_decisions"]:
            with self.subTest(stage=stage):
                errors = _schema_errors(stage, {})
                self.assertTrue(any(error["code"] == "schema_required" for error in errors))

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
                "transform": {},
                "transition_in": "none",
                "transition_out": "none",
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
                "transform": {"scale": 1.5},
                "transition_in": "fade",
                "transition_out": "fade",
                "reason": "局部放大关键区域",
            },
        ],
        "overlays": [],
        "audio": {},
        "subtitles": {},
        "transitions": [],
        "end_card": {},
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
