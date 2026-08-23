from __future__ import annotations

import re
from math import isfinite
from typing import Any

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
    expected_duration: float | None = None,
) -> list[dict]:
    if not isinstance(value, dict):
        return [_error("$", "invalid_type", "顶层必须是 JSON 对象", value)]
    validator = {
        "proposal": _proposal,
        "storyboard": _storyboard,
    }.get(stage)
    if validator is None:
        return [_error("$", "unknown_stage", f"不支持的编辑方案阶段：{stage}")]
    return validator(value, expected_duration=expected_duration)


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


def _proposal(value: dict, **_: Any) -> list[dict]:
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
            errors.append(_error(f"{path}.grounded_in", "invalid_array", "必须是非空字符串数组，用 requirement:<要点> / assumption:<假设> 说明依据", grounded))
        else:
            for ref in grounded:
                if ref.startswith("asset:"):
                    errors.append(_error(f"{path}.grounded_in", "unknown_asset_ref", "本流程没有输入素材，grounded_in 不得引用 asset_id", ref))
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


def _storyboard(
    value: dict,
    *,
    expected_duration: float | None = None,
    **_: Any,
) -> list[dict]:
    errors: list[dict] = []
    _version(value, errors)
    for field in ["title", "objective", "audience", "concept_summary"]:
        _string(value, field, errors)

    fmt = value.get("format")
    if not isinstance(fmt, dict):
        errors.append(_error("format", "invalid_type", "必须是对象", fmt))
    else:
        _string(fmt, "platform", errors, path="format")
        _string(fmt, "aspect_ratio", errors, path="format")
        _string(fmt, "delivery_notes", errors, path="format", allow_empty=True)

    cover = value.get("cover")
    if not isinstance(cover, dict):
        errors.append(_error("cover", "invalid_type", "必须是对象", cover))
    else:
        _string(cover, "concept", errors, path="cover")
        _string(cover, "text_overlay", errors, path="cover", allow_empty=True)
        _string(cover, "reason", errors, path="cover")

    duration = _number(value.get("total_duration_seconds"), "total_duration_seconds", errors, minimum=1)
    if expected_duration is not None and duration is not None and abs(duration - expected_duration) > 0.05:
        errors.append(_error("total_duration_seconds", "duration_mismatch", "与提案选中方向的目标时长不一致", duration))

    shots = value.get("shots")
    if not isinstance(shots, list) or not shots:
        errors.append(_error("shots", "missing_or_empty", "必须是非空数组", shots))
        return errors
    shot_ids: set[str] = set()
    for index, item in enumerate(shots):
        path = f"shots[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["id", "label", "visual"]:
            _string(item, field, errors, path=path)
        for field in ["narration", "subtitle", "asset_need", "notes"]:
            _string(item, field, errors, path=path, allow_empty=True)
        shot_id = item.get("id")
        if isinstance(shot_id, str):
            if shot_id in shot_ids:
                errors.append(_error(f"{path}.id", "duplicate", "镜头 ID 必须唯一", shot_id))
            shot_ids.add(shot_id)
        start = _number(item.get("start_seconds"), f"{path}.start_seconds", errors, minimum=0)
        end = _number(item.get("end_seconds"), f"{path}.end_seconds", errors, minimum=0)
        narration = item.get("narration")
        if start is not None and end is not None and end > start and isinstance(narration, str) and narration:
            estimated = _estimated_speech_seconds(narration)
            available = end - start
            if estimated > available * 1.2:
                errors.append(_error(
                    f"{path}.narration",
                    "speech_rate_infeasible",
                    f"按快语速估算约需 {estimated:.1f} 秒，超过镜头时长 {available:.1f} 秒；请精简文本或延长镜头",
                    {"estimated_seconds": round(estimated, 2), "available_seconds": round(available, 2)},
                ))
    _check_timeline(shots, "shots", "start_seconds", "end_seconds", errors, expected_duration=duration)
    _string(value, "audio_notes", errors, allow_empty=True)
    _string_array(value, "assumptions", errors, allow_empty=True)
    _string_array(value, "risks", errors, allow_empty=True)
    return errors


def _estimated_speech_seconds(text: str) -> float:
    """按较快旁白语速估算朗读秒数：中文 6 字/秒，英文 3.5 词/秒。"""
    cjk_chars = sum(1 for char in text if "一" <= char <= "鿿")  # CJK 统一表意文字 U+4E00–U+9FFF
    words = len(re.findall(r"[A-Za-z0-9]+", text))
    return cjk_chars / 6.0 + words / 3.5


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
