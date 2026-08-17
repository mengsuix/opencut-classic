from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class Hotspot:
    platform: str
    title: str
    url: str
    rank: int
    heat: int | None = None
    id: str = ""
    also_on: list[str] = field(default_factory=list)
    matched_topics: list[str] = field(default_factory=list)


class Source(Protocol):
    name: str
    region: str  # "cn" | "global"

    def fetch(self) -> list[Hotspot]: ...


CN_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

_HEAT_RE = re.compile(r"([\d.]+)\s*(亿|万)?")


def parse_heat(text: str | None) -> int | None:
    if not text:
        return None
    m = _HEAT_RE.search(text)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    if m.group(2) == "亿":
        return int(n * 100_000_000)
    if m.group(2) == "万":
        return int(n * 10_000)
    return int(n)
