from __future__ import annotations

import re
from math import isfinite
from typing import Any

MEDIA_TYPES = {"video", "audio", "image", "document", "text", "archive", "unknown"}
NARRATIVE_ROLES = {
    "establish_context",
    "introduce_subject",
    "build_tension",
    "deliver_payload",
    "transition",
    "emotional_beat",
    "evidence",
    "comparison",
    "resolution",
    "call_to_action",
}
SOURCE_TYPES = {"provided", "supplemental", "generate", "record", "text"}
RENDER_RUNTIMES = {"remotion", "hyperframes", "ffmpeg", "not_selected"}
RENDERER_FAMILIES = {
    "explainer-data",
    "explainer-teacher",
    "cinematic-trailer",
    "documentary-montage",
    "product-reveal",
    "screen-demo",
    "presenter",
    "animation-first",
    "not_selected",
}


def validate_artifact(
    stage: str,
    value: object,
    *,
    asset_ids: set[str],
    asset_catalog: dict[str, dict] | None = None,
    expected_duration: float | None = None,
    script_section_ids: set[str] | None = None,
    supplemental_ids: set[str] | None = None,
    scene_ids: set[str] | None = None,
    expected_renderer_family: str | None = None,
    expected_render_runtime: str | None = None,
) -> list[dict]:
    if not isinstance(value, dict):
        return [_error("$", "invalid_type", "顶层必须是 JSON 对象", value)]
    validator = {
        "source_media_review": _source_media_review,
        "proposal": _proposal,
        "script": _script,
        "scene_plan": _scene_plan,
        "asset_plan": _asset_plan,
        "edit_decisions": _edit_decisions,
    }.get(stage)
    if validator is None:
        return [_error("$", "unknown_stage", f"不支持的编辑方案阶段：{stage}")]
    return validator(
        value,
        asset_ids=asset_ids,
        asset_catalog=asset_catalog or {},
        expected_duration=expected_duration,
        script_section_ids=script_section_ids or set(),
        supplemental_ids=supplemental_ids or set(),
        scene_ids=scene_ids or set(),
        expected_renderer_family=expected_renderer_family,
        expected_render_runtime=expected_render_runtime,
    )


def validate_video_plan(
    value: object,
    *,
    asset_ids: set[str],
    asset_catalog: dict[str, dict] | None = None,
) -> list[dict]:
    if not isinstance(value, dict):
        return [_error("$", "invalid_type", "顶层必须是 JSON 对象", value)]
    errors: list[dict] = []
    _version(value, errors, "2.0", field="schema_version")
    for field in ["title", "objective", "audience"]:
        _string(value, field, errors)
    duration = _number(value.get("target_duration_sec"), "target_duration_sec", errors, minimum=5)
    for field in [
        "format",
        "style",
        "cover",
        "proposal",
        "script",
        "scene_plan",
        "asset_plan",
        "edit_decisions",
        "delivery",
        "plan_review",
    ]:
        _object_field(value, field, errors)

    artifacts = value.get("artifacts")
    if not isinstance(artifacts, dict):
        errors.append(_error("artifacts", "invalid_type", "必须是对象", artifacts))
        return errors

    source_review = artifacts.get("source_media_review")
    proposal = artifacts.get("proposal")
    script = artifacts.get("script")
    scene_plan = artifacts.get("scene_plan")
    asset_plan = artifacts.get("asset_plan")
    edit_decisions = artifacts.get("edit_decisions")
    catalog = asset_catalog or {}
    proposal_duration, expected_family, expected_runtime = _proposal_contract(proposal)
    script_duration = script.get("total_duration_seconds") if isinstance(script, dict) else None
    section_ids = _ids(script, "sections")
    scene_ids = _ids(scene_plan, "scenes")
    supplemental_ids = _ids(asset_plan, "supplemental_assets")

    errors.extend(validate_artifact("source_media_review", source_review, asset_ids=asset_ids, asset_catalog=catalog))
    errors.extend(validate_artifact("proposal", proposal, asset_ids=asset_ids, asset_catalog=catalog))
    errors.extend(
        validate_artifact(
            "script",
            script,
            asset_ids=asset_ids,
            asset_catalog=catalog,
            expected_duration=proposal_duration,
        )
    )
    errors.extend(
        validate_artifact(
            "asset_plan",
            asset_plan,
            asset_ids=asset_ids,
            asset_catalog=catalog,
            expected_duration=script_duration if isinstance(script_duration, (int, float)) else None,
            script_section_ids=section_ids,
            scene_ids=scene_ids,
        )
    )
    errors.extend(
        validate_artifact(
            "scene_plan",
            scene_plan,
            asset_ids=asset_ids,
            asset_catalog=catalog,
            expected_duration=script_duration if isinstance(script_duration, (int, float)) else None,
            script_section_ids=section_ids,
            supplemental_ids=supplemental_ids,
        )
    )
    errors.extend(
        validate_artifact(
            "edit_decisions",
            edit_decisions,
            asset_ids=asset_ids,
            asset_catalog=catalog,
            expected_duration=script_duration if isinstance(script_duration, (int, float)) else None,
            script_section_ids=section_ids,
            supplemental_ids=supplemental_ids,
            scene_ids=scene_ids,
            expected_renderer_family=expected_family,
            expected_render_runtime=expected_runtime,
        )
    )
    if duration is not None and isinstance(script_duration, (int, float)) and abs(duration - script_duration) > 0.05:
        errors.append(_error("target_duration_sec", "duration_mismatch", "必须与 script.total_duration_seconds 一致", duration))
    if proposal_duration is not None and isinstance(script_duration, (int, float)) and abs(proposal_duration - script_duration) > 0.05:
        errors.append(_error("script.total_duration_seconds", "duration_mismatch", "必须与选中提案的目标时长一致", script_duration))
    _validate_review(value.get("plan_review"), errors)
    _array_field(value, "decisions", errors)
    _string_array(value, "assumptions", errors, allow_empty=True)
    _string_array(value, "risks", errors, allow_empty=True)
    return errors


def _proposal_contract(value: object) -> tuple[float | None, str | None, str | None]:
    if not isinstance(value, dict):
        return None, None, None
    selected = value.get("selected_concept")
    options = value.get("concept_options")
    selected_id = selected.get("concept_id") if isinstance(selected, dict) else None
    selected_option = next(
        (item for item in options if isinstance(item, dict) and item.get("id") == selected_id),
        None,
    ) if isinstance(options, list) else None
    duration = selected_option.get("target_duration_seconds") if isinstance(selected_option, dict) else None
    production = value.get("production_plan")
    family = production.get("renderer_family") if isinstance(production, dict) else None
    runtime = production.get("render_runtime") if isinstance(production, dict) else None
    return (
        float(duration) if _finite_number(duration) else None,
        family if isinstance(family, str) else None,
        runtime if isinstance(runtime, str) else None,
    )


def _ids(value: object, field: str) -> set[str]:
    if not isinstance(value, dict) or not isinstance(value.get(field), list):
        return set()
    return {item.get("id") for item in value[field] if isinstance(item, dict) and isinstance(item.get("id"), str)}


def _source_media_review(
    value: dict,
    *,
    asset_ids: set[str],
    asset_catalog: dict[str, dict],
    **_: Any,
) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    _string(value, "summary", errors)
    _string_array(value, "planning_implications", errors)
    policy = value.get("reference_policy")
    if not isinstance(policy, dict):
        errors.append(_error("reference_policy", "invalid_type", "必须是对象", policy))
    else:
        _string(policy, "default_role", errors, path="reference_policy")
        _string(policy, "reuse_rule", errors, path="reference_policy")
        if policy.get("default_role") != "reference_material":
            errors.append(_error("reference_policy.default_role", "invalid_value", "必须是 reference_material", policy.get("default_role")))

    files = value.get("files")
    if not isinstance(files, list):
        errors.append(_error("files", "invalid_type", "必须是数组", files))
        return errors
    seen: set[str] = set()
    for index, item in enumerate(files):
        path = f"files[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["asset_id", "path", "reference_role", "reuse_policy", "content_summary"]:
            _string(item, field, errors, path=path)
        _enum(item, "media_type", MEDIA_TYPES, errors, path=path)
        if item.get("reviewed") is not True:
            errors.append(_error(f"{path}.reviewed", "not_reviewed", "必须明确为 true，表示已完成检查", item.get("reviewed")))
        asset_id = item.get("asset_id")
        if isinstance(asset_id, str):
            if asset_id in seen:
                errors.append(_error(f"{path}.asset_id", "duplicate", "asset_id 必须唯一", asset_id))
            if asset_id not in asset_ids:
                errors.append(_error(f"{path}.asset_id", "unknown_asset_ref", "不是输入清单中的 asset_id", asset_id))
            expected_path = asset_catalog.get(asset_id, {}).get("path")
            if expected_path and item.get("path") != expected_path:
                errors.append(_error(f"{path}.path", "path_mismatch", "必须使用清单中的相对路径", item.get("path")))
            seen.add(asset_id)
        _object_field(item, "technical_probe", errors, path=path)
        _string_array(item, "representative_frames", errors, path=path, allow_empty=True)
        _string_array(item, "quality_risks", errors, path=path, allow_empty=True)
        _string_array(item, "usable_for", errors, path=path, allow_empty=True)
    missing = sorted(asset_ids - seen)
    if missing:
        errors.append(_error("files", "missing_assets", "必须审核输入清单中的每个 asset_id", missing))
    return errors


def _proposal(value: dict, *, asset_ids: set[str], **_: Any) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    options = value.get("concept_options")
    if not isinstance(options, list) or len(options) < 3:
        errors.append(_error("concept_options", "missing_or_short", "必须提供至少 3 个不同方向", options))
        options = options if isinstance(options, list) else []
    concept_ids: set[str] = set()
    for index, item in enumerate(options):
        path = f"concept_options[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "title", "hook", "visual_approach", "core_message", "cta", "why_this_works"]:
            _string(item, field, errors, path=path)
        grounded = item.get("grounded_in")
        if not isinstance(grounded, list) or not grounded or any(not isinstance(ref, str) or not ref.strip() for ref in grounded):
            errors.append(_error(f"{path}.grounded_in", "invalid_array", "必须是非空字符串数组，用 asset:<asset_id> / requirement:<要点> / assumption:<假设> 说明依据", grounded))
        else:
            for ref in grounded:
                if ref.startswith("asset:") and ref.split(":", 1)[1].strip() not in asset_ids:
                    errors.append(_error(f"{path}.grounded_in", "unknown_asset_ref", "grounded_in 引用了不存在的输入素材", ref))
        _enum(item, "narrative_structure", {"analogy", "problem_solution", "journey", "debate", "myth_busting", "timeline", "comparison", "tutorial", "story", "data_narrative"}, errors, path=path)
        _number(item.get("target_duration_seconds"), f"{path}.target_duration_seconds", errors, minimum=1)
        _string_array(item, "key_points", errors, path=path)
        concept_id = item.get("id")
        if isinstance(concept_id, str):
            if concept_id in concept_ids:
                errors.append(_error(f"{path}.id", "duplicate", "概念 ID 必须唯一", concept_id))
            concept_ids.add(concept_id)

    selected = value.get("selected_concept")
    if not isinstance(selected, dict):
        errors.append(_error("selected_concept", "invalid_type", "必须是对象", selected))
    else:
        _string(selected, "concept_id", errors, path="selected_concept")
        _string(selected, "rationale", errors, path="selected_concept")
        if isinstance(selected.get("concept_id"), str) and selected["concept_id"] not in concept_ids:
            errors.append(_error("selected_concept.concept_id", "unknown_concept", "必须引用 concept_options 中的 ID", selected["concept_id"]))

    production = value.get("production_plan")
    if not isinstance(production, dict):
        errors.append(_error("production_plan", "invalid_type", "必须是对象", production))
    else:
        for field in ["pipeline", "renderer_family", "render_runtime"]:
            _string(production, field, errors, path="production_plan")
        if production.get("renderer_family") not in RENDERER_FAMILIES or production.get("renderer_family") == "not_selected":
            errors.append(_error("production_plan.renderer_family", "invalid_enum", "必须选择支持的 renderer_family", production.get("renderer_family")))
        if production.get("render_runtime") not in RENDER_RUNTIMES or production.get("render_runtime") == "not_selected":
            errors.append(_error("production_plan.render_runtime", "invalid_enum", "必须选择支持的 render_runtime", production.get("render_runtime")))
        stages = production.get("stages")
        if not isinstance(stages, list) or not stages:
            errors.append(_error("production_plan.stages", "missing_or_empty", "必须是非空阶段数组", stages))
        else:
            for index, item in enumerate(stages):
                path = f"production_plan.stages[{index}]"
                if not isinstance(item, dict):
                    errors.append(_error(path, "invalid_type", "必须是对象", item))
                    continue
                for field in ["stage", "approach"]:
                    _string(item, field, errors, path=path)
                tools = item.get("tools")
                if not isinstance(tools, list):
                    errors.append(_error(f"{path}.tools", "invalid_type", "必须是数组", tools))
        delivery = production.get("delivery_promise")
        if not isinstance(delivery, dict):
            errors.append(_error("production_plan.delivery_promise", "invalid_type", "必须是对象", delivery))
        else:
            for field in ["promise_type", "tone_mode", "quality_floor"]:
                _string(delivery, field, errors, path="production_plan.delivery_promise")
            if not isinstance(delivery.get("motion_required"), bool):
                errors.append(_error("production_plan.delivery_promise.motion_required", "invalid_type", "必须是布尔值", delivery.get("motion_required")))
        _array_field(production, "quality_tradeoffs", errors, path="production_plan")
        _array_field(production, "alternative_paths", errors, path="production_plan")

    _object_field(value, "cost_estimate", errors)
    cost = value.get("cost_estimate")
    if isinstance(cost, dict):
        _number(cost.get("total_estimated_usd"), "cost_estimate.total_estimated_usd", errors, minimum=0)
        _string(cost, "budget_verdict", errors, path="cost_estimate")
        _array_field(cost, "line_items", errors, path="cost_estimate")
    approval = value.get("approval")
    if not isinstance(approval, dict):
        errors.append(_error("approval", "invalid_type", "必须是对象", approval))
    else:
        _enum(approval, "status", {"pending", "approved", "approved_with_changes", "rejected"}, errors, path="approval")
    for field in ["format", "creative_direction"]:
        _object_field(value, field, errors)
    return errors


def _estimated_speech_seconds(text: str) -> float:
    """按较快旁白语速估算朗读秒数：中文 6 字/秒，英文 3.5 词/秒。"""
    cjk_chars = sum(1 for char in text if "一" <= char <= "鿿")  # CJK 统一表意文字 U+4E00–U+9FFF
    words = len(re.findall(r"[A-Za-z0-9]+", text))
    return cjk_chars / 6.0 + words / 3.5


def _script(value: dict, *, expected_duration: float | None = None, **_: Any) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    _string(value, "title", errors)
    duration = _number(value.get("total_duration_seconds"), "total_duration_seconds", errors, minimum=1)
    if expected_duration is not None and duration is not None and abs(duration - expected_duration) > 0.05:
        errors.append(_error("total_duration_seconds", "duration_mismatch", "与上游目标时长不一致", duration))
    performance = value.get("voice_performance")
    if not isinstance(performance, dict):
        errors.append(_error("voice_performance", "invalid_type", "必须是对象", performance))
    else:
        for field in ["performance_intent", "pacing_profile", "energy_curve", "pause_policy"]:
            _string(performance, field, errors, path="voice_performance")
        _enum(performance, "pacing_profile", {"contemplative", "conversational", "energetic", "technical", "cinematic", "custom"}, errors, path="voice_performance")
    sections = value.get("sections")
    if not isinstance(sections, list) or not sections:
        errors.append(_error("sections", "missing_or_empty", "必须是非空数组", sections))
        return errors
    ids: set[str] = set()
    for index, item in enumerate(sections):
        path = f"sections[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "label", "text", "source_basis"]:
            _string(item, field, errors, path=path)
        _string(item, "speaker_directions", errors, path=path, allow_empty=True)
        section_id = item.get("id")
        if isinstance(section_id, str):
            if section_id in ids:
                errors.append(_error(f"{path}.id", "duplicate", "脚本段 ID 必须唯一", section_id))
            ids.add(section_id)
        start = _number(item.get("start_seconds"), f"{path}.start_seconds", errors, minimum=0)
        end = _number(item.get("end_seconds"), f"{path}.end_seconds", errors, minimum=0)
        text = item.get("text")
        if start is not None and end is not None and end > start and isinstance(text, str):
            estimated = _estimated_speech_seconds(text)
            available = end - start
            if estimated > available * 1.2:
                errors.append(_error(
                    f"{path}.text",
                    "speech_rate_infeasible",
                    f"按快语速估算约需 {estimated:.1f} 秒，超过段落时长 {available:.1f} 秒；请精简文本或延长段落",
                    {"estimated_seconds": round(estimated, 2), "available_seconds": round(available, 2)},
                ))
        _object_field(item, "delivery_cues", errors, path=path)
        _array_field(item, "enhancement_cues", errors, path=path)
    _check_timeline(sections, "sections", "start_seconds", "end_seconds", errors, expected_duration=duration)
    _string_array(value, "factual_notes", errors, allow_empty=True)
    return errors


def _scene_plan(
    value: dict,
    *,
    asset_ids: set[str],
    expected_duration: float | None = None,
    script_section_ids: set[str],
    supplemental_ids: set[str],
    **_: Any,
) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    _string(value, "style_playbook", errors)
    scenes = value.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        errors.append(_error("scenes", "missing_or_empty", "必须是非空数组", scenes))
        return errors
    scene_ids: set[str] = set()
    for index, item in enumerate(scenes):
        path = f"scenes[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "type", "description", "framing", "movement", "transition_in", "transition_out", "shot_intent", "narrative_role", "information_role"]:
            _string(item, field, errors, path=path)
        _enum(item, "type", {"talking_head", "broll", "animation", "character_scene", "diagram", "text_card", "transition", "generated", "screen_recording"}, errors, path=path)
        _enum(item, "narrative_role", NARRATIVE_ROLES, errors, path=path)
        _number(item.get("start_seconds"), f"{path}.start_seconds", errors, minimum=0)
        _number(item.get("end_seconds"), f"{path}.end_seconds", errors, minimum=0)
        if not isinstance(item.get("hero_moment"), bool):
            errors.append(_error(f"{path}.hero_moment", "invalid_type", "必须是布尔值", item.get("hero_moment")))
        if item.get("script_section_id") not in script_section_ids:
            errors.append(_error(f"{path}.script_section_id", "unknown_section", "必须引用脚本中的 section ID", item.get("script_section_id")))
        _object_field(item, "shot_language", errors, path=path)
        required_assets = item.get("required_assets")
        if not isinstance(required_assets, list):
            errors.append(_error(f"{path}.required_assets", "invalid_type", "必须是数组", required_assets))
        else:
            for asset_index, asset in enumerate(required_assets):
                asset_path = f"{path}.required_assets[{asset_index}]"
                if not isinstance(asset, dict):
                    errors.append(_error(asset_path, "invalid_type", "必须是对象", asset))
                    continue
                for field in ["type", "description", "source"]:
                    _string(asset, field, errors, path=asset_path)
                _enum(asset, "source", SOURCE_TYPES, errors, path=asset_path)
                if asset.get("source") == "provided":
                    _string(asset, "asset_ref", errors, path=asset_path)
                    if isinstance(asset.get("asset_ref"), str) and asset["asset_ref"] not in asset_ids:
                        errors.append(_error(f"{asset_path}.asset_ref", "unknown_asset_ref", "分镜引用了不存在的输入素材", asset["asset_ref"]))
                if asset.get("source") == "supplemental":
                    _string(asset, "supplemental_id", errors, path=asset_path)
                    if supplemental_ids and isinstance(asset.get("supplemental_id"), str) and asset["supplemental_id"] not in supplemental_ids:
                        errors.append(_error(f"{asset_path}.supplemental_id", "unknown_supplemental_ref", "分镜引用了不存在的补充素材", asset["supplemental_id"]))
    if len(scenes) >= 4:
        signatures = {
            (item.get("type"), item.get("framing"), item.get("movement"))
            for item in scenes
            if isinstance(item, dict)
        }
        if len(signatures) == 1:
            errors.append(_error(
                "scenes",
                "no_visual_variation",
                "所有场景的类型/构图/运动完全雷同；必须变化视觉语法，避免成片像幻灯片",
                {"scene_count": len(scenes)},
            ))
    _check_timeline(scenes, "scenes", "start_seconds", "end_seconds", errors, expected_duration=expected_duration)
    metadata = value.get("metadata")
    if not isinstance(metadata, dict):
        errors.append(_error("metadata", "invalid_type", "必须是对象", metadata))
    else:
        for field in ["crop_regions", "callout_plan", "speed_plan", "quality_gates"]:
            _array_field(metadata, field, errors, path="metadata")
        if not metadata.get("quality_gates"):
            errors.append(_error("metadata.quality_gates", "missing_or_empty", "必须至少有一个质量门"))
    return errors


def _asset_plan(
    value: dict,
    *,
    asset_ids: set[str],
    expected_duration: float | None = None,
    script_section_ids: set[str],
    scene_ids: set[str],
    **_: Any,
) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    assets = value.get("assets")
    if not isinstance(assets, list):
        errors.append(_error("assets", "invalid_type", "必须是数组", assets))
        assets = []
    for index, item in enumerate(assets):
        path = f"assets[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["asset_ref", "role", "use_reason"]:
            _string(item, field, errors, path=path)
        if item.get("asset_ref") not in asset_ids:
            errors.append(_error(f"{path}.asset_ref", "unknown_asset_ref", "引用了不存在的输入素材", item.get("asset_ref")))
        if not isinstance(item.get("selected"), bool):
            errors.append(_error(f"{path}.selected", "invalid_type", "必须是布尔值", item.get("selected")))

    supplemental = value.get("supplemental_assets")
    if not isinstance(supplemental, list):
        errors.append(_error("supplemental_assets", "invalid_type", "必须是数组", supplemental))
        supplemental = []
    supplemental_ids: set[str] = set()
    for index, item in enumerate(supplemental):
        path = f"supplemental_assets[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "type", "purpose", "description", "acquisition"]:
            _string(item, field, errors, path=path)
        _enum(item, "priority", {"must_have", "recommended", "optional"}, errors, path=path)
        _string_array(item, "scene_ids", errors, path=path, allow_empty=True)
        for scene_id in item.get("scene_ids", []):
            if isinstance(scene_id, str) and scene_id not in scene_ids:
                errors.append(_error(f"{path}.scene_ids", "unknown_scene_ref", "补充素材引用了不存在的场景 ID", scene_id))
        item_id = item.get("id")
        if isinstance(item_id, str):
            if item_id in supplemental_ids:
                errors.append(_error(f"{path}.id", "duplicate", "补充素材 ID 必须唯一", item_id))
            supplemental_ids.add(item_id)

    cover = value.get("cover")
    if not isinstance(cover, dict):
        errors.append(_error("cover", "invalid_type", "必须是对象", cover))
    else:
        _enum(cover, "source", {"provided_asset", "supplemental_asset", "text_card", "ai_generated", "poster_frame"}, errors, path="cover")
        for field in ["concept", "text_overlay", "style_notes", "safe_area_notes", "reason"]:
            _string(cover, field, errors, path="cover", allow_empty=field == "text_overlay")
        for field in ["asset_refs", "supplemental_asset_refs"]:
            _string_array(cover, field, errors, path="cover", allow_empty=True)
        for ref in cover.get("asset_refs", []):
            if isinstance(ref, str) and ref not in asset_ids:
                errors.append(_error("cover.asset_refs", "unknown_asset_ref", "封面引用了不存在的输入素材", ref))
        for ref in cover.get("supplemental_asset_refs", []):
            if isinstance(ref, str) and ref not in supplemental_ids:
                errors.append(_error("cover.supplemental_asset_refs", "unknown_supplemental_ref", "封面引用了不存在的补充素材", ref))

    narration = value.get("narration")
    if not isinstance(narration, dict):
        errors.append(_error("narration", "invalid_type", "必须是对象", narration))
    else:
        if not isinstance(narration.get("enabled"), bool):
            errors.append(_error("narration.enabled", "invalid_type", "必须是布尔值", narration.get("enabled")))
        for field in ["language", "tone", "provider"]:
            _string(narration, field, errors, path="narration")
        segments = narration.get("segments")
        if not isinstance(segments, list):
            errors.append(_error("narration.segments", "invalid_type", "必须是数组", segments))
        else:
            _check_timeline_overlap(segments, "narration.segments", "start_seconds", "end_seconds", errors)
            for index, item in enumerate(segments):
                path = f"narration.segments[{index}]"
                if not isinstance(item, dict):
                    errors.append(_error(path, "invalid_type", "必须是对象", item))
                    continue
                for field in ["script_section_id", "text"]:
                    _string(item, field, errors, path=path)
                if isinstance(item.get("script_section_id"), str) and item["script_section_id"] not in script_section_ids:
                    errors.append(_error(f"{path}.script_section_id", "unknown_section", "旁白引用了不存在的脚本段", item["script_section_id"]))
                _number(item.get("start_seconds"), f"{path}.start_seconds", errors, minimum=0)
                _number(item.get("end_seconds"), f"{path}.end_seconds", errors, minimum=0)

    subtitles = value.get("subtitles")
    if not isinstance(subtitles, dict):
        errors.append(_error("subtitles", "invalid_type", "必须是对象", subtitles))
    else:
        for field in ["source", "style", "position"]:
            _string(subtitles, field, errors, path="subtitles")
        if not isinstance(subtitles.get("enabled"), bool):
            errors.append(_error("subtitles.enabled", "invalid_type", "必须是布尔值", subtitles.get("enabled")))
        _number(subtitles.get("max_words_per_line"), "subtitles.max_words_per_line", errors, minimum=1)

    music = value.get("music")
    if not isinstance(music, dict):
        errors.append(_error("music", "invalid_type", "必须是对象", music))
    else:
        for field in ["source_type", "mood", "track_plan", "ducking"]:
            _string(music, field, errors, path="music")

    chapters = value.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        errors.append(_error("chapters", "missing_or_empty", "必须是非空数组", chapters))
    else:
        previous = -1.0
        for index, chapter in enumerate(chapters):
            path = f"chapters[{index}]"
            if not isinstance(chapter, dict):
                errors.append(_error(path, "invalid_type", "必须是对象", chapter))
                continue
            _string(chapter, "id", errors, path=path)
            _string(chapter, "title", errors, path=path)
            start = _number(chapter.get("start_seconds"), f"{path}.start_seconds", errors, minimum=0)
            if start is not None and start < previous:
                errors.append(_error(path, "out_of_order", "章节必须按时间排序"))
            if start is not None:
                previous = start
            if expected_duration is not None and start is not None and start > expected_duration:
                errors.append(_error(f"{path}.start_seconds", "out_of_range", "章节不能超过目标时长", start))
    _object_field(value, "delivery", errors)
    return errors


def _edit_decisions(
    value: dict,
    *,
    asset_ids: set[str],
    expected_duration: float | None = None,
    supplemental_ids: set[str],
    scene_ids: set[str],
    expected_renderer_family: str | None = None,
    expected_render_runtime: str | None = None,
    **_: Any,
) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    _enum(value, "renderer_family", RENDERER_FAMILIES - {"not_selected"}, errors)
    _enum(value, "render_runtime", RENDER_RUNTIMES - {"not_selected"}, errors)
    if expected_renderer_family and value.get("renderer_family") != expected_renderer_family:
        errors.append(_error("renderer_family", "renderer_mismatch", "必须与提案锁定的 renderer_family 一致", value.get("renderer_family")))
    if expected_render_runtime and value.get("render_runtime") != expected_render_runtime:
        errors.append(_error("render_runtime", "runtime_mismatch", "必须与提案锁定的 render_runtime 一致", value.get("render_runtime")))
    if expected_render_runtime != "not_selected" and value.get("render_runtime") == "not_selected":
        errors.append(_error("render_runtime", "runtime_not_selected", "最终剪辑决策必须选择渲染运行时"))
    _string(value, "delivery_promise", errors)
    cuts = value.get("cuts")
    if not isinstance(cuts, list) or not cuts:
        errors.append(_error("cuts", "missing_or_empty", "必须是非空数组", cuts))
        cuts = []
    for index, item in enumerate(cuts):
        path = f"cuts[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "scene_id", "source_type", "source", "layer", "transition_in", "transition_out", "reason"]:
            _string(item, field, errors, path=path)
        _enum(item, "source_type", SOURCE_TYPES, errors, path=path)
        _enum(item, "layer", {"primary", "overlay", "background"}, errors, path=path)
        if isinstance(item.get("scene_id"), str) and item["scene_id"] not in scene_ids:
            errors.append(_error(f"{path}.scene_id", "unknown_scene_ref", "剪辑引用了不存在的场景 ID", item["scene_id"]))
        if item.get("source_type") == "provided" and item.get("source") not in asset_ids:
            errors.append(_error(f"{path}.source", "unknown_asset_ref", "剪辑引用了不存在的输入素材", item.get("source")))
        if item.get("source_type") == "supplemental" and item.get("source") not in supplemental_ids:
            errors.append(_error(f"{path}.source", "unknown_supplemental_ref", "剪辑引用了不存在的补充素材", item.get("source")))
        in_seconds = _number(item.get("in_seconds"), f"{path}.in_seconds", errors, minimum=0)
        out_seconds = _number(item.get("out_seconds"), f"{path}.out_seconds", errors, minimum=0)
        _number(item.get("timeline_start"), f"{path}.timeline_start", errors, minimum=0)
        _number(item.get("timeline_end"), f"{path}.timeline_end", errors, minimum=0)
        _number(item.get("speed"), f"{path}.speed", errors, minimum=0.1)
        if in_seconds is not None and out_seconds is not None and out_seconds <= in_seconds:
            errors.append(_error(f"{path}.out_seconds", "invalid_source_range", "必须大于 in_seconds", out_seconds))
        _object_field(item, "transform", errors, path=path)
    _check_cut_timeline(cuts, errors, expected_duration=expected_duration)
    _array_field(value, "overlays", errors)
    _array_field(value, "transitions", errors)
    _object_field(value, "audio", errors)
    _object_field(value, "subtitles", errors)
    _object_field(value, "end_card", errors)
    _object_field(value, "metadata", errors)
    metadata = value.get("metadata")
    if isinstance(metadata, dict):
        for field in ["crop_keyframes", "speed_plan", "subtitle_position_overrides", "audio_notes", "variant_notes", "quality_gates"]:
            _array_field(metadata, field, errors, path="metadata")
        if not metadata.get("quality_gates"):
            errors.append(_error("metadata.quality_gates", "missing_or_empty", "必须至少有一个质量门"))
    return errors


def _check_cut_timeline(cuts: list[object], errors: list[dict], *, expected_duration: float | None) -> None:
    by_layer: dict[str, list[tuple[int, float, float]]] = {}
    for index, item in enumerate(cuts):
        if not isinstance(item, dict):
            continue
        start = item.get("timeline_start")
        end = item.get("timeline_end")
        layer = item.get("layer")
        if not _finite_number(start) or not _finite_number(end) or not isinstance(layer, str) or float(end) <= float(start):
            continue
        by_layer.setdefault(layer, []).append((index, float(start), float(end)))

    primary = sorted(by_layer.get("primary", []), key=lambda item: item[1])
    if not primary:
        errors.append(_error("cuts", "missing_primary_track", "必须有 primary 轨道覆盖主画面"))
    else:
        previous_end = 0.0
        for index, start, end in primary:
            if abs(start - previous_end) > 0.05:
                errors.append(_error(f"cuts[{index}]", "timeline_gap", "primary 轨道必须从 0 秒连续覆盖", {"expected_start": previous_end, "actual_start": start}))
            previous_end = end
        if expected_duration is not None and abs(previous_end - expected_duration) > 0.05:
            errors.append(_error("cuts", "duration_mismatch", "primary 轨道末尾必须等于目标时长", {"actual_end": previous_end, "expected_end": expected_duration}))

    for layer, intervals in by_layer.items():
        if layer == "primary":
            continue
        ordered = sorted(intervals, key=lambda item: item[1])
        previous_end = -1.0
        for index, start, end in ordered:
            if previous_end >= 0 and start < previous_end - 0.05:
                errors.append(_error(f"cuts[{index}]", "layer_overlap", f"{layer} 轨道内部不能意外重叠"))
            previous_end = max(previous_end, end)


def _validate_review(value: object, errors: list[dict]) -> None:
    if not isinstance(value, dict):
        errors.append(_error("plan_review", "invalid_type", "必须是对象", value))
        return
    _enum(value, "status", {"passed", "passed_with_risks", "failed"}, errors, path="plan_review")
    if not isinstance(value.get("human_approval_required"), bool):
        errors.append(_error("plan_review.human_approval_required", "invalid_type", "必须是布尔值", value.get("human_approval_required")))
    _string(value, "next_action", errors, path="plan_review")
    _array_field(value, "checks", errors, path="plan_review")
    _array_field(value, "unresolved_risks", errors, path="plan_review")


def _check_timeline(
    items: list[object],
    path: str,
    start_key: str,
    end_key: str,
    errors: list[dict],
    *,
    expected_duration: float | None,
) -> None:
    previous_end = 0.0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        start = item.get(start_key)
        end = item.get(end_key)
        if not _finite_number(start) or not _finite_number(end) or float(end) <= float(start):
            errors.append(_error(f"{path}[{index}]", "invalid_range", "结束时间必须大于开始时间"))
            continue
        if abs(float(start) - previous_end) > 0.05:
            errors.append(_error(f"{path}[{index}]", "timeline_gap", "时间轴必须从 0 秒连续覆盖", {"expected_start": previous_end, "actual_start": start}))
        previous_end = float(end)
    if items and expected_duration is not None and abs(previous_end - float(expected_duration)) > 0.05:
        errors.append(_error(path, "duration_mismatch", "时间轴末尾必须等于目标时长", {"actual_end": previous_end, "expected_end": expected_duration}))


def _check_timeline_overlap(items: list[object], path: str, start_key: str, end_key: str, errors: list[dict]) -> None:
    previous_end = 0.0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        start = item.get(start_key)
        end = item.get(end_key)
        if not _finite_number(start) or not _finite_number(end):
            errors.append(_error(f"{path}[{index}]", "invalid_range", "时间必须是有限数字"))
            continue
        if float(end) <= float(start):
            errors.append(_error(f"{path}[{index}]", "invalid_range", "结束时间必须大于开始时间"))
        if float(start) < previous_end - 0.05:
            errors.append(_error(f"{path}[{index}]", "overlap", "时间段不能重叠"))
        previous_end = max(previous_end, float(end))


def _version(value: dict, errors: list[dict], expected: str = "1.0", *, field: str = "version") -> None:
    if value.get(field) != expected:
        errors.append(_error(field, "invalid_value", f"必须是 {expected}", value.get(field)))


def _string(value: dict, field: str, errors: list[dict], *, path: str = "", allow_empty: bool = False) -> None:
    actual = value.get(field)
    full_path = f"{path}.{field}" if path else field
    if not isinstance(actual, str) or (not allow_empty and not actual.strip()):
        errors.append(_error(full_path, "missing_or_invalid", "必须是字符串" if allow_empty else "必须是非空字符串", actual))


def _number(value: object, path: str, errors: list[dict], *, minimum: float) -> float | None:
    if not _finite_number(value) or float(value) < minimum:
        errors.append(_error(path, "invalid_number", f"必须是不小于 {minimum} 的有限数字", value))
        return None
    return float(value)


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(float(value))


def _enum(value: dict, field: str, allowed: set[str], errors: list[dict], *, path: str = "") -> None:
    actual = value.get(field)
    _string(value, field, errors, path=path)
    if isinstance(actual, str) and actual not in allowed:
        full_path = f"{path}.{field}" if path else field
        errors.append(_error(full_path, "invalid_enum", f"允许值：{', '.join(sorted(allowed))}", actual))


def _string_array(value: dict, field: str, errors: list[dict], *, path: str = "", allow_empty: bool = False) -> None:
    actual = value.get(field)
    full_path = f"{path}.{field}" if path else field
    items = actual if isinstance(actual, list) else []
    if not isinstance(actual, list) or (not allow_empty and not actual) or any(not isinstance(item, str) or not item.strip() for item in items):
        errors.append(_error(full_path, "invalid_array", "必须是字符串数组" + ("（可为空）" if allow_empty else ""), actual))


def _object_field(value: dict, field: str, errors: list[dict], *, path: str = "") -> None:
    actual = value.get(field)
    full_path = f"{path}.{field}" if path else field
    if not isinstance(actual, dict):
        errors.append(_error(full_path, "invalid_type", "必须是对象", actual))


def _array_field(value: dict, field: str, errors: list[dict], *, path: str = "") -> None:
    actual = value.get(field)
    full_path = f"{path}.{field}" if path else field
    if not isinstance(actual, list):
        errors.append(_error(full_path, "invalid_type", "必须是数组", actual))


def _error(path: str, code: str, message: str, actual: object = None) -> dict:
    result = {"path": path, "code": code, "message": message}
    if actual is not None:
        result["actual"] = actual
    return result
