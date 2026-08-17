from __future__ import annotations

import html as html_mod
import re
from typing import TypedDict

from .types import CN_UA, Hotspot, parse_heat
from .util import fetch_text

MAX_ITEMS = 30
TIMEOUT = 45.0  # 美区访问 tophub 较慢

_TABLE_RE = re.compile(r"<table[^>]*>([\s\S]*?)</table>")
_ROW_RE = re.compile(r"<tr[^>]*>([\s\S]*?)</tr>")
_A_RE = re.compile(r"<a ([^>]*)>([\s\S]*?)</a>")
_HREF_RE = re.compile(r'href="([^"]*)"')
_TD_WS_RE = re.compile(r'<td class="ws">([^<]*)</td>')
_DESC_RE = re.compile(r'<div class="item-desc">([\s\S]*?)</div>')


class TophubNode(TypedDict):
    node: str
    platform: str
    name: str


def fetch_node(node: TophubNode) -> list[Hotspot]:
    text = fetch_text(
        f"https://tophub.today/n/{node['node']}",
        ua=CN_UA,
        referer="https://tophub.today/",
        timeout=TIMEOUT,
    )
    table_m = _TABLE_RE.search(text)
    table = table_m.group(1) if table_m else ""
    items: list[Hotspot] = []
    for row_m in _ROW_RE.finditer(table):
        seg = row_m.group(1)
        title, url = "", ""
        for a_m in _A_RE.finditer(seg):
            if "itemid=" not in a_m.group(1):
                continue
            title = html_mod.unescape(a_m.group(2)).strip()
            href_m = _HREF_RE.search(a_m.group(1))
            url = href_m.group(1) if href_m else ""
            break
        if not title:
            continue
        ws_m = _TD_WS_RE.search(seg)
        desc_m = _DESC_RE.search(seg)
        heat_text = (
            (ws_m.group(1) if ws_m else None)
            or (desc_m.group(1) if desc_m else None)
            or ""
        ).strip()
        items.append(
            Hotspot(
                platform=node["platform"],
                title=title,
                url=url,
                rank=len(items) + 1,
                heat=parse_heat(heat_text),
            )
        )
        if len(items) >= MAX_ITEMS:
            break
    return items


class TophubSource:
    region = "cn"

    def __init__(self, node: TophubNode):
        self.node = node
        self.name = f"tophub:{node['platform']}"

    def fetch(self) -> list[Hotspot]:
        return fetch_node(self.node)


def tophub_sources(nodes: list[TophubNode]) -> list[TophubSource]:
    return [TophubSource(n) for n in nodes]
