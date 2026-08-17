from __future__ import annotations

import math
from statistics import fmean

from .types import Hotspot


def _source_platform(name: str) -> str:
    return name.removeprefix("tophub:")


def _stat_value(stat: object, name: str, default):
    if isinstance(stat, dict):
        return stat.get(name, default)
    return getattr(stat, name, default)


def _observations(item: Hotspot) -> list[tuple[str, int, int | None]]:
    observations = getattr(item, "_observations", None)
    if observations:
        return observations
    return [(item.platform, item.rank, item.heat)]


def _heat_value(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        heat = float(value)
    except (TypeError, ValueError):
        return None
    return heat if math.isfinite(heat) and heat >= 0 else None


def _platform_limits(
    stats: list,
    observations: list[list[tuple[str, int, int | None]]],
) -> dict[str, int]:
    limits: dict[str, int] = {}
    for stat in stats:
        if _stat_value(stat, "error", None):
            continue
        platform = _source_platform(str(_stat_value(stat, "name", "")))
        count = _stat_value(stat, "count", 0)
        if platform and isinstance(count, int) and count > 0:
            limits[platform] = max(limits.get(platform, 0), count)
    for item_observations in observations:
        for platform, rank, _ in item_observations:
            limits[platform] = max(limits.get(platform, 0), rank)
    return limits


def _rank_score(rank: int, limit: int) -> float:
    if limit <= 1:
        return 1.0
    return max(0.0, min(1.0, 1.0 - (rank - 1) / (limit - 1)))


def _heat_bounds(
    observations: list[list[tuple[str, int, int | None]]],
) -> dict[str, tuple[float, float]]:
    values: dict[str, list[float]] = {}
    for item_observations in observations:
        for platform, _, raw_heat in item_observations:
            heat = _heat_value(raw_heat)
            if heat is not None:
                values.setdefault(platform, []).append(math.log1p(heat))
    return {
        platform: (min(platform_values), max(platform_values))
        for platform, platform_values in values.items()
    }


def _heat_score(
    platform: str,
    raw_heat: object,
    bounds: dict[str, tuple[float, float]],
) -> float | None:
    heat = _heat_value(raw_heat)
    if heat is None or platform not in bounds:
        return None
    value = math.log1p(heat)
    low, high = bounds[platform]
    if high == low:
        return 0.5
    return max(0.0, min(1.0, (value - low) / (high - low)))


def _best_platform_observations(
    item_observations: list[tuple[str, int, int | None]],
    limits: dict[str, int],
) -> list[tuple[str, int, int | None]]:
    best: dict[str, tuple[str, int, int | None]] = {}
    for observation in item_observations:
        platform, rank, raw_heat = observation
        current = best.get(platform)
        rank_score = _rank_score(rank, limits[platform])
        current_rank_score = (
            _rank_score(current[1], limits[platform]) if current else None
        )
        heat = _heat_value(raw_heat)
        current_heat = _heat_value(current[2]) if current else None
        if (
            current is None
            or rank_score > current_rank_score
            or (
                rank_score == current_rank_score
                and heat is not None
                and (current_heat is None or heat > current_heat)
            )
        ):
            best[platform] = observation
    return list(best.values())


def rank_hotspots(items: list[Hotspot], stats: list) -> list[Hotspot]:
    """按覆盖度、平台内排名和平台内相对热度进行无平台权重排序。"""
    all_observations = [_observations(item) for item in items]
    limits = _platform_limits(stats, all_observations)
    if not limits:
        return sorted(items, key=lambda item: (item.rank, item.platform, item.title, item.id))

    bounds = _heat_bounds(all_observations)
    platform_count = len(limits)
    scored: list[
        tuple[tuple[float, float, float, float, str, str, str], Hotspot]
    ] = []

    for item, item_observations in zip(items, all_observations):
        observations = _best_platform_observations(item_observations, limits)
        coverage_score = len(observations) / platform_count
        rank_scores = [
            _rank_score(rank, limits[platform])
            for platform, rank, _ in observations
        ]
        heat_scores = [
            score
            for platform, _, raw_heat in observations
            if (score := _heat_score(platform, raw_heat, bounds)) is not None
        ]
        dimensions = [coverage_score, fmean(rank_scores)]
        if heat_scores:
            dimensions.append(fmean(heat_scores))
        score = fmean(dimensions)
        heat_tiebreak = fmean(heat_scores) if heat_scores else 0.0
        key = (
            -score,
            -coverage_score,
            -fmean(rank_scores),
            -heat_tiebreak,
            item.platform,
            item.title,
            item.id,
        )
        scored.append((key, item))

    return [item for _, item in sorted(scored, key=lambda entry: entry[0])]
