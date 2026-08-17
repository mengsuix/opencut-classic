from __future__ import annotations

import re
import unicodedata

from .types import Hotspot

_PUNCT_RE = re.compile(r"[\s\W_]+", re.UNICODE)


def _normalize(title: str) -> str:
    return _PUNCT_RE.sub("", unicodedata.normalize("NFKC", title).lower())


def _bigrams(s: str) -> set[str]:
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return inter / union if union else 0.0


def _observations(item: Hotspot) -> list[tuple[str, int, int | None]]:
    observations = getattr(item, "_observations", None)
    if observations is None:
        observations = [(item.platform, item.rank, item.heat)]
        setattr(item, "_observations", observations)
    return observations


def dedup(items: list[Hotspot], threshold: float = 0.55) -> list[Hotspot]:
    """跨平台去重：相似标题合并到先出现（rank 更小）的条目，平台记入 also_on。"""
    kept: list[tuple[Hotspot, set[str]]] = []
    for item in sorted(items, key=lambda x: (x.rank, x.platform, x.title, x.id)):
        _observations(item)
        grams = _bigrams(_normalize(item.title))
        if not grams:
            continue
        dup = next((k for k in kept if _jaccard(k[1], grams) >= threshold), None)
        if dup is not None:
            _observations(dup[0]).extend(_observations(item))
            if item.platform != dup[0].platform and item.platform not in dup[0].also_on:
                dup[0].also_on.append(item.platform)
        else:
            kept.append((item, grams))
    return [k[0] for k in kept]
