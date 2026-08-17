from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict

from .dedup import dedup
from .types import Hotspot, Source


class SourceStat:
    def __init__(self, name: str, count: int = 0, error: str | None = None):
        self.name = name
        self.count = count
        self.error = error

    def to_dict(self) -> dict:
        d = {"name": self.name, "count": self.count}
        if self.error:
            d["error"] = self.error
        return d


def _make_id(platform: str, title: str) -> str:
    digest = hashlib.md5((platform + title).encode("utf-8")).hexdigest()[:10]
    return f"{platform}:{digest}"


def fetch_all(
    sources: list[Source],
    timeout: float = 90.0,
) -> tuple[list[Hotspot], list[SourceStat]]:
    """并发抓取所有源，单源失败不影响整体；结果做跨平台去重。"""
    items: list[Hotspot] = []
    stats: list[SourceStat] = []
    with ThreadPoolExecutor(max_workers=min(len(sources) or 1, 8)) as pool:
        future_to_source = {pool.submit(s.fetch): s for s in sources}
        for future in as_completed(future_to_source, timeout=timeout):
            source = future_to_source[future]
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 - 单源失败仅记录
                stats.append(SourceStat(source.name, error=str(exc)))
                continue
            stats.append(SourceStat(source.name, count=len(result)))
            for h in result:
                h.id = _make_id(h.platform, h.title)
            items.extend(result)
    stats.sort(key=lambda s: s.name)
    return dedup(items), stats


def hotspot_to_dict(h: Hotspot) -> dict:
    return asdict(h)
