import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline.edit_plan import EditPlanInputError, build_agent_prompt, run_edit_plan, scan_directory
from pipeline.tcodex import TcodexResult
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

    def test_end_to_end_writes_only_final_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requirements = root / "requirements.txt"
            requirements.write_text("制作一条产品视频。", encoding="utf-8")
            output_dir = root / "out"
            output_dir.mkdir()
            (output_dir / "video-plan.json").write_text("old", encoding="utf-8")
            (output_dir / "plan-review.json").write_text("old", encoding="utf-8")
            (output_dir / ".edit-plan" / "stages").mkdir(parents=True)
            (output_dir / ".edit-plan" / "stages" / "proposal.json").write_text("old", encoding="utf-8")

            with mock.patch("pipeline.edit_plan.TcodexClient", _FakeTcodexClient):
                summary = run_edit_plan(requirements=requirements, output_dir=output_dir)

            self.assertEqual(summary["status"], "succeeded")
            self.assertEqual(summary["completed_stages"], [
                "source_media_review",
                "proposal",
                "script",
                "scene_plan",
                "asset_plan",
                "edit_decisions",
            ])
            self.assertEqual(summary["output_files"], ["video-plan.json"])
            self.assertEqual(list(output_dir.iterdir()), [output_dir / "video-plan.json"])

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
    if stage == "source_media_review":
        return {
            "version": "1.0",
            "files": [],
            "summary": "输入目录没有可用素材，全部内容需要补充。",
            "planning_implications": ["所有画面和音频均需列为补充素材"],
            "reference_policy": {"default_role": "reference_material", "reuse_rule": "没有可复用素材"},
            "assumptions": [],
            "risks": [],
        }
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
    if stage == "script":
        return {
            "version": "1.0",
            "title": "测试视频",
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
                    "text": "这是十秒的开场旁白。",
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
    if stage == "scene_plan":
        return {
            "version": "1.0",
            "style_playbook": "clean-professional",
            "scenes": [
                {
                    "id": "scene_01",
                    "type": "text_card",
                    "description": "标题文字卡",
                    "start_seconds": 0,
                    "end_seconds": 5,
                    "script_section_id": "sec_1",
                    "framing": "全景",
                    "movement": "静止",
                    "transition_in": "无",
                    "transition_out": "切",
                    "shot_intent": "建立主题",
                    "narrative_role": "establish_context",
                    "information_role": "主题信息",
                    "hero_moment": False,
                    "required_assets": [],
                    "shot_language": {"shot_size": "", "camera_angle": "", "notes": ""},
                    "overlay_notes": "",
                },
                {
                    "id": "scene_02",
                    "type": "generated",
                    "description": "生成画面展示结果",
                    "start_seconds": 5,
                    "end_seconds": 10,
                    "script_section_id": "sec_1",
                    "framing": "中景",
                    "movement": "推近",
                    "transition_in": "切",
                    "transition_out": "无",
                    "shot_intent": "展示结果",
                    "narrative_role": "resolution",
                    "information_role": "结果信息",
                    "hero_moment": True,
                    "required_assets": [],
                    "shot_language": {"shot_size": "", "camera_angle": "", "notes": ""},
                    "overlay_notes": "",
                },
            ],
            "metadata": {"crop_regions": [], "callout_plan": [], "speed_plan": [], "quality_gates": ["检查时间线连续性"]},
            "assumptions": [],
            "risks": [],
        }
    if stage == "asset_plan":
        return {
            "version": "1.0",
            "assets": [],
            "supplemental_assets": [],
            "cover": {
                "source": "text_card",
                "concept": "标题封面",
                "text_overlay": "测试视频",
                "style_notes": "简洁",
                "safe_area_notes": "居中安全区",
                "reason": "无可用素材",
                "asset_refs": [],
                "supplemental_asset_refs": [],
            },
            "narration": {"enabled": True, "language": "中文", "tone": "自然", "provider": "待选 TTS", "segments": []},
            "subtitles": {"enabled": True, "source": "旁白", "style": "白字黑边", "position": "底部", "max_words_per_line": 18},
            "music": {
                "source_type": "补充音乐",
                "mood": "轻快",
                "track_plan": "全程低音量",
                "ducking": "旁白时压低",
                "fade_in_seconds": 0,
                "fade_out_seconds": 0,
            },
            "chapters": [{"id": "ch_1", "title": "开场", "start_seconds": 0}],
            "delivery": {
                "platform": "通用",
                "aspect_ratio": "16:9",
                "resolution": "1920x1080",
                "fps": 30,
                "codec": "h264",
                "notes": "高清导出",
            },
            "assumptions": [],
            "risks": [],
        }
    if stage == "edit_decisions":
        return {
            "version": "1.0",
            "renderer_family": "screen-demo",
            "render_runtime": "remotion",
            "delivery_promise": "信息清晰",
            "cuts": [
                {
                    "id": "cut_01",
                    "scene_id": "scene_01",
                    "source_type": "text",
                    "source": "标题文字卡",
                    "in_seconds": 0,
                    "out_seconds": 5,
                    "timeline_start": 0,
                    "timeline_end": 5,
                    "speed": 1,
                    "layer": "primary",
                    "transform": {"scale": None, "position": "", "notes": ""},
                    "transition_in": "无",
                    "transition_out": "切",
                    "transition_duration": 0,
                    "reason": "开场建立主题",
                },
                {
                    "id": "cut_02",
                    "scene_id": "scene_02",
                    "source_type": "generate",
                    "source": "结果画面",
                    "in_seconds": 0,
                    "out_seconds": 5,
                    "timeline_start": 5,
                    "timeline_end": 10,
                    "speed": 1,
                    "layer": "primary",
                    "transform": {"scale": None, "position": "", "notes": ""},
                    "transition_in": "切",
                    "transition_out": "无",
                    "transition_duration": 0,
                    "reason": "展示结果",
                },
            ],
            "overlays": [],
            "audio": {"narration": "", "music": "", "sound_effects": "", "ducking": ""},
            "subtitles": {"style": "", "position": "", "notes": ""},
            "transitions": [],
            "end_card": {"headline": "", "subheadline": "", "cta": "", "visual": "", "audio": ""},
            "metadata": {
                "crop_keyframes": [],
                "speed_plan": [],
                "subtitle_position_overrides": [],
                "audio_notes": [],
                "variant_notes": [],
                "quality_gates": ["检查主轨连续性"],
            },
            "assumptions": [],
            "risks": [],
        }
    raise AssertionError(f"未知阶段：{stage}")


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
