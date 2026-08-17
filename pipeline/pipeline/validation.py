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


def _object(value: object) -> list[dict]:
    return [] if isinstance(value, dict) else [_error("$", "invalid_type", "顶层必须是 JSON 对象", value)]


def _required_string(value: dict, field: str, errors: list[dict], *, allowed: set[str] | None = None, path: str = "") -> None:
    full_path = f"{path}.{field}" if path else field
    actual = value.get(field)
    if not isinstance(actual, str) or not actual.strip():
        errors.append(_error(full_path, "missing_or_invalid", "必须是非空字符串", actual))
    elif allowed and actual not in allowed:
        errors.append(_error(full_path, "invalid_enum", f"允许值：{', '.join(sorted(allowed))}", actual))


def _required_lists(value: dict, fields: list[str], errors: list[dict]) -> None:
    for field in fields:
        if not isinstance(value.get(field), list) or any(not isinstance(item, str) or not item.strip() for item in value[field]):
            errors.append(_error(field, "invalid_type", "必须是字符串数组", value.get(field)))


def _required_style(value: dict, errors: list[dict]) -> None:
    style = value.get("style")
    if not isinstance(style, dict):
        errors.append(_error("style", "invalid_type", "必须是包含 labels 和 description 的对象", style))
        return
    labels = style.get("labels")
    if not isinstance(labels, list) or not labels or any(not isinstance(item, str) or not item.strip() for item in labels):
        errors.append(_error("style.labels", "invalid_type", "必须是非空字符串数组", labels))
    if not isinstance(style.get("description"), str) or not style["description"].strip():
        errors.append(_error("style.description", "missing_or_invalid", "必须是非空字符串", style.get("description")))


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
