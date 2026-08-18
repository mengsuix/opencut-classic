from __future__ import annotations

import ipaddress
from urllib.parse import urlparse


ALLOWED_ASSET_TYPES = {
    "screen_record",
    "web_image",
    "ai_image",
    "ai_video",
    "text_card",
}


def validate_stage(stage: str, value: object) -> list[dict]:
    if stage == "deconstruction":
        return validate_deconstruction(value)
    if stage == "judge":
        return validate_judge(value)
    if stage == "plan":
        return validate_plan(value)
    return [_error("$", "unknown_stage", f"不支持的阶段：{stage}")]


def validate_deconstruction(value: object) -> list[dict]:
    errors = _object(value)
    if errors:
        return errors
    assert isinstance(value, dict)
    _required_lists(value, ["product_elements", "hotspot_elements", "audience", "content_elements", "must_avoid"], errors)
    _required_style(value, errors)
    _required_list_of_objects(value, "connection_angles", {"angle", "reason"}, errors)
    return errors


def validate_judge(value: object) -> list[dict]:
    errors = _object(value)
    if errors:
        return errors
    assert isinstance(value, dict)
    score = value.get("score")
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 100:
        errors.append(_error("score", "out_of_range", "必须是 0 到 100 之间的整数", score))
    _required_string(value, "decision", errors, allowed={"recommended", "revise", "reject"})
    _required_string(value, "reason", errors)
    _required_list_of_objects(value, "score_breakdown", {"dimension", "score", "reason"}, errors, string_fields={"dimension", "reason"})
    _required_list_of_objects(value, "evidence", {"claim", "url", "title"}, errors)
    _required_lists(value, ["uncertainties", "risks"], errors)
    for index, item in enumerate(value.get("evidence", [])):
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not _is_public_http_url(url):
            errors.append(_error(f"evidence[{index}].url", "invalid_url", "必须是公开的 http/https URL", url))
    for index, item in enumerate(value.get("score_breakdown", [])):
        if not isinstance(item, dict):
            continue
        score_value = item.get("score")
        if isinstance(score_value, bool) or not isinstance(score_value, int) or not 0 <= score_value <= 10:
            errors.append(_error(f"score_breakdown[{index}].score", "out_of_range", "必须是 0 到 10 之间的整数", score_value))
    return errors


def validate_plan(value: object) -> list[dict]:
    errors = _object(value)
    if errors:
        return errors
    assert isinstance(value, dict)
    for field in ["title", "angle", "hook", "script", "platform_fit"]:
        _required_string(value, field, errors)
    _required_style(value, errors)
    duration = value.get("duration")
    if isinstance(duration, bool) or not isinstance(duration, int) or not 30 <= duration <= 60:
        errors.append(_error("duration", "out_of_range", "必须是 30 到 60 之间的整数", duration))
    assets = value.get("assets")
    if not isinstance(assets, list) or not assets:
        errors.append(_error("assets", "missing_or_empty", "必须是非空数组"))
    else:
        for index, asset in enumerate(assets):
            if not isinstance(asset, dict):
                errors.append(_error(f"assets[{index}]", "invalid_type", "必须是对象", asset))
                continue
            for field in ["type", "desc", "source"]:
                _required_string(asset, field, errors, path=f"assets[{index}]")
            if asset.get("type") not in ALLOWED_ASSET_TYPES:
                errors.append(_error(f"assets[{index}].type", "invalid_enum", "素材类型不在允许列表中", asset.get("type")))
    return errors


def validate_edit_plan(value: object, *, asset_ids: set[str] | None = None) -> list[dict]:
    errors = _object(value)
    if errors:
        return errors
    assert isinstance(value, dict)
    required_strings = ["schema_version", "title", "objective", "audience"]
    for field in required_strings:
        _required_string(value, field, errors)
    if value.get("schema_version") != "1.0":
        errors.append(_error("schema_version", "invalid_enum", "必须是 1.0", value.get("schema_version")))

    format_value = value.get("format")
    if not isinstance(format_value, dict):
        errors.append(_error("format", "invalid_type", "必须是对象", format_value))
    else:
        for field in ["platform", "aspect_ratio", "delivery_notes"]:
            _required_string(format_value, field, errors, path="format")

    style = value.get("style")
    if not isinstance(style, dict):
        errors.append(_error("style", "invalid_type", "必须是对象", style))
    else:
        _required_style(style, errors, path="style")

    target_duration = value.get("target_duration_sec")
    if isinstance(target_duration, bool) or not isinstance(target_duration, (int, float)) or not 5 <= target_duration <= 1800:
        errors.append(_error("target_duration_sec", "out_of_range", "必须是 5 到 1800 之间的数字", target_duration))

    cover = value.get("cover")
    if not isinstance(cover, dict):
        errors.append(_error("cover", "invalid_type", "必须是对象", cover))
    else:
        for field in ["source", "visual_description", "headline", "layout", "treatment", "reason"]:
            _required_string(cover, field, errors, path="cover")
        _required_string(cover, "source", errors, allowed={"provided_asset", "supplemental_asset", "text_card", "ai_generated"}, path="cover")
        _required_string_array(cover, "asset_refs", errors, allow_empty=True)
        _required_string_array(cover, "supplemental_asset_refs", errors, allow_empty=True)

    scenes = value.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        errors.append(_error("scenes", "missing_or_empty", "必须是非空数组", scenes))
    else:
        previous_end = 0.0
        scene_ids: set[str] = set()
        all_refs: list[tuple[str, str]] = []
        for index, scene in enumerate(scenes):
            path = f"scenes[{index}]"
            if not isinstance(scene, dict):
                errors.append(_error(path, "invalid_type", "必须是对象", scene))
                continue
            _required_string(scene, "scene_id", errors, path=path)
            scene_id = scene.get("scene_id")
            if isinstance(scene_id, str):
                if scene_id in scene_ids:
                    errors.append(_error(f"{path}.scene_id", "duplicate", "场景 ID 必须唯一", scene_id))
                scene_ids.add(scene_id)
            for field in ["purpose", "visual", "camera_motion", "transition", "emphasis"]:
                _required_string(scene, field, errors, path=path)
            start = _number(scene.get("start_sec"), f"{path}.start_sec", errors, minimum=0)
            end = _number(scene.get("end_sec"), f"{path}.end_sec", errors, minimum=0)
            if start is not None and end is not None:
                if end <= start:
                    errors.append(_error(f"{path}.end_sec", "invalid_range", "必须大于 start_sec", end))
                if abs(start - previous_end) > 0.05:
                    errors.append(_error(path, "timeline_gap", "场景时间轴必须从 0 秒连续覆盖", {"expected_start": previous_end, "actual_start": start}))
                previous_end = end
            _required_string_array(scene, "asset_refs", errors, allow_empty=True)
            _required_string_array(scene, "supplemental_asset_refs", errors, allow_empty=True)
            for ref in scene.get("asset_refs", []):
                if isinstance(ref, str):
                    all_refs.append((f"{path}.asset_refs", ref))
            _validate_source_ranges(scene, path, errors, all_refs)
            _validate_text_overlays(scene, path, errors)
            _required_string(scene, "narration", errors, path=path, allow_empty=True)
            audio = scene.get("audio")
            if not isinstance(audio, dict):
                errors.append(_error(f"{path}.audio", "invalid_type", "必须是对象", audio))
            else:
                for field in ["narration_treatment", "music", "mix_notes"]:
                    _required_string(audio, field, errors, path=f"{path}.audio")
                _required_string_array(audio, "sound_effects", errors, path=f"{path}.audio", allow_empty=True)

        if previous_end and target_duration is not None and isinstance(target_duration, (int, float)):
            if abs(previous_end - target_duration) > 0.05:
                errors.append(_error("scenes", "duration_mismatch", "场景末尾必须等于目标时长", {"scene_end": previous_end, "target": target_duration}))

    voiceover = value.get("voiceover")
    if not isinstance(voiceover, dict):
        errors.append(_error("voiceover", "invalid_type", "必须是对象", voiceover))
    else:
        if not isinstance(voiceover.get("enabled"), bool):
            errors.append(_error("voiceover.enabled", "invalid_type", "必须是布尔值", voiceover.get("enabled")))
        for field in ["language", "tone"]:
            _required_string(voiceover, field, errors, path="voiceover")
        _validate_timed_segments(voiceover.get("segments"), "voiceover.segments", errors, require_text=True)

    captions = value.get("captions")
    if not isinstance(captions, dict):
        errors.append(_error("captions", "invalid_type", "必须是对象", captions))
    else:
        for field in ["source", "style", "position"]:
            _required_string(captions, field, errors, path="captions")
        if not isinstance(captions.get("enabled"), bool):
            errors.append(_error("captions.enabled", "invalid_type", "必须是布尔值", captions.get("enabled")))
        max_chars = captions.get("max_chars_per_line")
        if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 8 <= max_chars <= 80:
            errors.append(_error("captions.max_chars_per_line", "out_of_range", "必须是 8 到 80 之间的整数", max_chars))

    music = value.get("music")
    if not isinstance(music, dict):
        errors.append(_error("music", "invalid_type", "必须是对象", music))
    else:
        if not isinstance(music.get("required"), bool):
            errors.append(_error("music.required", "invalid_type", "必须是布尔值", music.get("required")))
        for field in ["mood", "source", "notes"]:
            _required_string(music, field, errors, path="music")
        ducking = music.get("ducking_db")
        if isinstance(ducking, bool) or not isinstance(ducking, (int, float)) or not -60 <= ducking <= 0:
            errors.append(_error("music.ducking_db", "out_of_range", "必须是 -60 到 0 之间的数字", ducking))

    _validate_supplemental_assets(value.get("supplemental_assets"), errors)
    _validate_end_card(value.get("end_card"), errors)
    _required_string_array(value, "assumptions", errors, allow_empty=True)
    _required_string_array(value, "risks", errors, allow_empty=True)

    if asset_ids is not None:
        for ref_path, ref in _all_asset_refs(value):
            if ref not in asset_ids:
                errors.append(_error(ref_path, "unknown_asset_ref", "引用了素材清单中不存在的 asset_id", ref))
        for ref_path, ref in _all_supplemental_refs(value):
            known = {item.get("proposal_id") for item in value.get("supplemental_assets", []) if isinstance(item, dict)}
            if ref not in known:
                errors.append(_error(ref_path, "unknown_supplemental_ref", "引用了补充素材清单中不存在的 proposal_id", ref))

    return errors


def _validate_source_ranges(scene: dict, path: str, errors: list[dict], all_refs: list[tuple[str, str]]) -> None:
    ranges = scene.get("source_ranges")
    if not isinstance(ranges, list):
        errors.append(_error(f"{path}.source_ranges", "invalid_type", "必须是数组", ranges))
        return
    for index, item in enumerate(ranges):
        item_path = f"{path}.source_ranges[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(item_path, "invalid_type", "必须是对象", item))
            continue
        _required_string(item, "asset_ref", errors, path=item_path)
        ref = item.get("asset_ref")
        if isinstance(ref, str):
            all_refs.append((f"{item_path}.asset_ref", ref))
        start = _number(item.get("source_start_sec"), f"{item_path}.source_start_sec", errors, minimum=0)
        end = _number(item.get("source_end_sec"), f"{item_path}.source_end_sec", errors, minimum=0)
        if start is not None and end is not None and end <= start:
            errors.append(_error(f"{item_path}.source_end_sec", "invalid_range", "必须大于 source_start_sec", end))
        _required_string(item, "selection_reason", errors, path=item_path)


def _validate_text_overlays(scene: dict, path: str, errors: list[dict]) -> None:
    overlays = scene.get("on_screen_text")
    if not isinstance(overlays, list):
        errors.append(_error(f"{path}.on_screen_text", "invalid_type", "必须是数组", overlays))
        return
    for index, overlay in enumerate(overlays):
        item_path = f"{path}.on_screen_text[{index}]"
        if not isinstance(overlay, dict):
            errors.append(_error(item_path, "invalid_type", "必须是对象", overlay))
            continue
        for field in ["text", "style", "position"]:
            _required_string(overlay, field, errors, path=item_path)


def _validate_timed_segments(segments: object, path: str, errors: list[dict], *, require_text: bool) -> None:
    if not isinstance(segments, list):
        errors.append(_error(path, "invalid_type", "必须是数组", segments))
        return
    previous_end = 0.0
    for index, segment in enumerate(segments):
        item_path = f"{path}[{index}]"
        if not isinstance(segment, dict):
            errors.append(_error(item_path, "invalid_type", "必须是对象", segment))
            continue
        start = _number(segment.get("start_sec"), f"{item_path}.start_sec", errors, minimum=0)
        end = _number(segment.get("end_sec"), f"{item_path}.end_sec", errors, minimum=0)
        if start is not None and end is not None:
            if end <= start:
                errors.append(_error(f"{item_path}.end_sec", "invalid_range", "必须大于 start_sec", end))
            if start < previous_end:
                errors.append(_error(item_path, "overlap", "时间段不能重叠"))
            previous_end = max(previous_end, end)
        if require_text:
            _required_string(segment, "text", errors, path=item_path)


def _validate_supplemental_assets(items: object, errors: list[dict]) -> None:
    if not isinstance(items, list):
        errors.append(_error("supplemental_assets", "invalid_type", "必须是数组", items))
        return
    ids: set[str] = set()
    for index, item in enumerate(items):
        path = f"supplemental_assets[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for field in ["proposal_id", "kind", "purpose", "description", "acquisition"]:
            _required_string(item, field, errors, path=path)
        _required_string(item, "priority", errors, allowed={"must_have", "recommended", "optional"}, path=path)
        _required_string_array(item, "needed_for_scene_ids", errors, allow_empty=True)
        proposal_id = item.get("proposal_id")
        if isinstance(proposal_id, str):
            if proposal_id in ids:
                errors.append(_error(f"{path}.proposal_id", "duplicate", "补充素材 proposal_id 必须唯一", proposal_id))
            ids.add(proposal_id)


def _validate_end_card(value: object, errors: list[dict]) -> None:
    if not isinstance(value, dict):
        errors.append(_error("end_card", "invalid_type", "必须是对象", value))
        return
    for field in ["headline", "cta", "visual", "audio"]:
        _required_string(value, field, errors, path="end_card")
    for field in ["asset_refs", "supplemental_asset_refs"]:
        _required_string_array(value, field, errors, allow_empty=True)
    _number(value.get("start_sec"), "end_card.start_sec", errors, minimum=0)
    _number(value.get("duration_sec"), "end_card.duration_sec", errors, minimum=0)


def _required_string_array(value: dict, field: str, errors: list[dict], *, path: str = "", allow_empty: bool = False) -> None:
    full_path = f"{path}.{field}" if path else field
    actual = value.get(field)
    if not isinstance(actual, list) or any(not isinstance(item, str) or not item.strip() for item in actual) or (not allow_empty and not actual):
        errors.append(_error(full_path, "invalid_type", "必须是字符串数组" + ("（可为空）" if allow_empty else ""), actual))


def _number(value: object, path: str, errors: list[dict], *, minimum: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum:
        errors.append(_error(path, "invalid_number", f"必须是不小于 {minimum} 的数字", value))
        return None
    return float(value)


def _all_asset_refs(value: dict) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    cover = value.get("cover", {})
    if isinstance(cover, dict):
        refs.extend((f"cover.asset_refs[{index}]", ref) for index, ref in enumerate(cover.get("asset_refs", [])) if isinstance(ref, str))
    for index, scene in enumerate(value.get("scenes", [])):
        if isinstance(scene, dict):
            refs.extend((f"scenes[{index}].asset_refs[{ref_index}]", ref) for ref_index, ref in enumerate(scene.get("asset_refs", [])) if isinstance(ref, str))
            for range_index, item in enumerate(scene.get("source_ranges", [])):
                if isinstance(item, dict) and isinstance(item.get("asset_ref"), str):
                    refs.append((f"scenes[{index}].source_ranges[{range_index}].asset_ref", item["asset_ref"]))
    end_card = value.get("end_card", {})
    if isinstance(end_card, dict):
        refs.extend((f"end_card.asset_refs[{index}]", ref) for index, ref in enumerate(end_card.get("asset_refs", [])) if isinstance(ref, str))
    return refs


def _all_supplemental_refs(value: dict) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    cover = value.get("cover", {})
    if isinstance(cover, dict):
        refs.extend((f"cover.supplemental_asset_refs[{index}]", ref) for index, ref in enumerate(cover.get("supplemental_asset_refs", [])) if isinstance(ref, str))
    for index, scene in enumerate(value.get("scenes", [])):
        if isinstance(scene, dict):
            refs.extend((f"scenes[{index}].supplemental_asset_refs[{ref_index}]", ref) for ref_index, ref in enumerate(scene.get("supplemental_asset_refs", [])) if isinstance(ref, str))
    end_card = value.get("end_card", {})
    if isinstance(end_card, dict):
        refs.extend((f"end_card.supplemental_asset_refs[{index}]", ref) for index, ref in enumerate(end_card.get("supplemental_asset_refs", [])) if isinstance(ref, str))
    return refs


def _object(value: object) -> list[dict]:
    return [] if isinstance(value, dict) else [_error("$", "invalid_type", "顶层必须是 JSON 对象", value)]


def _required_string(
    value: dict,
    field: str,
    errors: list[dict],
    *,
    allowed: set[str] | None = None,
    path: str = "",
    allow_empty: bool = False,
) -> None:
    full_path = f"{path}.{field}" if path else field
    actual = value.get(field)
    if not isinstance(actual, str) or (not allow_empty and not actual.strip()):
        errors.append(_error(full_path, "missing_or_invalid", "必须是字符串" if allow_empty else "必须是非空字符串", actual))
    elif allowed and actual not in allowed:
        errors.append(_error(full_path, "invalid_enum", f"允许值：{', '.join(sorted(allowed))}", actual))


def _required_lists(value: dict, fields: list[str], errors: list[dict]) -> None:
    for field in fields:
        if not isinstance(value.get(field), list) or any(not isinstance(item, str) or not item.strip() for item in value[field]):
            errors.append(_error(field, "invalid_type", "必须是字符串数组", value.get(field)))


def _required_style(value: dict, errors: list[dict], *, path: str = "") -> None:
    style = value.get("style") if path == "" else value
    style_path = "style" if path == "" else path
    if not isinstance(style, dict):
        errors.append(_error(style_path, "invalid_type", "必须是包含 labels 和 description 的对象", style))
        return
    labels = style.get("labels")
    if not isinstance(labels, list) or not labels or any(not isinstance(item, str) or not item.strip() for item in labels):
        errors.append(_error(f"{style_path}.labels", "invalid_type", "必须是非空字符串数组", labels))
    if not isinstance(style.get("description"), str) or not style["description"].strip():
        errors.append(_error(f"{style_path}.description", "missing_or_invalid", "必须是非空字符串", style.get("description")))


def _required_list_of_objects(
    value: dict,
    field: str,
    required: set[str],
    errors: list[dict],
    *,
    string_fields: set[str] | None = None,
) -> None:
    items = value.get(field)
    if not isinstance(items, list) or not items:
        errors.append(_error(field, "missing_or_empty", "必须是非空对象数组", items))
        return
    string_fields = required if string_fields is None else string_fields
    for index, item in enumerate(items):
        path = f"{field}[{index}]"
        if not isinstance(item, dict):
            errors.append(_error(path, "invalid_type", "必须是对象", item))
            continue
        for key in required:
            actual = item.get(key)
            if key in string_fields and (not isinstance(actual, str) or not actual.strip()):
                errors.append(_error(f"{path}.{key}", "missing_or_invalid", "必须是非空字符串", actual))
            elif key not in string_fields and actual is None:
                errors.append(_error(f"{path}.{key}", "missing_or_invalid", "字段不能为空", actual))


def _is_public_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        host = parsed.hostname.lower().rstrip(".")
        if host == "localhost" or host.endswith(".local"):
            return False
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            return True
        return not (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        )
    except ValueError:
        return False


def _error(path: str, code: str, message: str, actual: object = None) -> dict:
    result = {"path": path, "code": code, "message": message}
    if actual is not None:
        result["actual"] = actual
    return result
