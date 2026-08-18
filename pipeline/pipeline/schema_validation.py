from __future__ import annotations

import math
from typing import Any


def validate_json_schema(value: object, schema: dict) -> list[dict]:
    errors: list[dict] = []
    _validate(value, schema, "$", errors)
    return errors


def _validate(value: object, schema: dict, path: str, errors: list[dict]) -> None:
    if "const" in schema and value != schema["const"]:
        errors.append(_error(path, "schema_const", f"必须等于 {schema['const']!r}", value))
        return

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        errors.append(_error(path, "schema_enum", f"允许值：{', '.join(repr(item) for item in enum)}", value))
        return

    expected_type = schema.get("type")
    if expected_type is not None and not _matches_type(value, expected_type):
        errors.append(_error(path, "schema_type", f"类型必须是 {expected_type}", value))
        return

    if isinstance(value, str):
        minimum = schema.get("minLength")
        if isinstance(minimum, int) and len(value) < minimum:
            errors.append(_error(path, "schema_min_length", f"长度不能小于 {minimum}", value))

    if _is_number(value):
        if not _finite(value):
            errors.append(_error(path, "schema_number", "必须是有限数字", value))
            return
        minimum = schema.get("minimum")
        if _is_number(minimum) and value < minimum:
            errors.append(_error(path, "schema_minimum", f"不能小于 {minimum}", value))
        exclusive_minimum = schema.get("exclusiveMinimum")
        if _is_number(exclusive_minimum) and value <= exclusive_minimum:
            errors.append(_error(path, "schema_exclusive_minimum", f"必须大于 {exclusive_minimum}", value))
        maximum = schema.get("maximum")
        if _is_number(maximum) and value > maximum:
            errors.append(_error(path, "schema_maximum", f"不能大于 {maximum}", value))

    if isinstance(value, list):
        minimum = schema.get("minItems")
        if isinstance(minimum, int) and len(value) < minimum:
            errors.append(_error(path, "schema_min_items", f"项目数不能小于 {minimum}", value))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                _validate(item, item_schema, f"{path}[{index}]", errors)

    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            for field in required:
                if isinstance(field, str) and field not in value:
                    errors.append(_error(f"{path}.{field}", "schema_required", "缺少必填字段"))
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}
        for field, child in properties.items():
            if field in value and isinstance(child, dict):
                _validate(value[field], child, f"{path}.{field}", errors)
        if schema.get("additionalProperties") is False:
            for field in value:
                if field not in properties:
                    errors.append(_error(f"{path}.{field}", "schema_additional_property", "不允许额外字段", value[field]))


def _matches_type(value: object, expected: object) -> bool:
    if isinstance(expected, list):
        return any(_matches_type(value, item) for item in expected)
    if expected == "null":
        return value is None
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return _is_number(value)
    return True


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(value: object) -> bool:
    return _is_number(value) and math.isfinite(float(value))


def _error(path: str, code: str, message: str, actual: object = None) -> dict:
    result = {"path": path, "code": code, "message": message}
    if actual is not None:
        result["actual"] = actual
    return result
