from __future__ import annotations

import re
import urllib.parse
from xml.etree import ElementTree

from .types import CN_UA, MOBILE_UA, Hotspot, parse_heat
from .util import fetch_json, fetch_text

MAX_ITEMS = 30


class WeiboSource:
    name = "weibo"
    region = "cn"

    def fetch(self) -> list[Hotspot]:
        data = fetch_json(
            "https://weibo.com/ajax/side/hotSearch",
            ua=CN_UA,
            referer="https://weibo.com/",
        )
        items: list[Hotspot] = []
        for it in (data.get("data") or {}).get("realtime") or []:
            word = it.get("word")
            title = (it.get("note") or word or "").strip()
            if not word or it.get("is_ad") or not title:
                continue
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url="https://s.weibo.com/weibo?q=" + urllib.parse.quote(word),
                    rank=len(items) + 1,
                    heat=it.get("num"),
                )
            )
            if len(items) >= MAX_ITEMS:
                break
        return items


class BilibiliSource:
    name = "bilibili"
    region = "cn"

    def fetch(self) -> list[Hotspot]:
        data = fetch_json(
            "https://api.bilibili.com/x/web-interface/search/square?limit=30",
            ua=CN_UA,
            referer="https://www.bilibili.com/",
        )
        items: list[Hotspot] = []
        for it in ((data.get("data") or {}).get("trending") or {}).get("list") or []:
            keyword = it.get("keyword")
            title = (it.get("show_name") or keyword or "").strip()
            if not keyword or not title:
                continue
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url="https://search.bilibili.com/all?keyword="
                    + urllib.parse.quote(keyword),
                    rank=len(items) + 1,
                )
            )
            if len(items) >= MAX_ITEMS:
                break
        return items


class ZhihuSource:
    name = "zhihu"
    region = "cn"

    def fetch(self) -> list[Hotspot]:
        data = fetch_json(
            "https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0",
            ua=MOBILE_UA,
        )
        items: list[Hotspot] = []
        for it in data.get("data") or []:
            target = it.get("target") or {}
            title = (target.get("title") or "").strip()
            if not title:
                continue
            tid, ttype = target.get("id"), target.get("type")
            if ttype == "article" and tid:
                url = f"https://zhuanlan.zhihu.com/p/{tid}"
            elif tid:
                url = f"https://www.zhihu.com/question/{tid}"
            else:
                url = target.get("url") or ""
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url=url,
                    rank=len(items) + 1,
                    heat=parse_heat(
                        it.get("detail_text")
                        or (it.get("metrics_area") or {}).get("text")
                    ),
                )
            )
            if len(items) >= MAX_ITEMS:
                break
        return items


class BaiduSource:
    name = "baidu"
    region = "cn"

    @staticmethod
    def _flatten(entries: list) -> list:
        out: list = []
        for e in entries:
            if e.get("word"):
                out.append(e)
            sub = e.get("content")
            if isinstance(sub, list):
                out.extend(BaiduSource._flatten(sub))
        return out

    def fetch(self) -> list[Hotspot]:
        data = fetch_json(
            "https://top.baidu.com/api/board?platform=wise&tab=realtime",
            ua=CN_UA,
            referer="https://top.baidu.com/board?tab=realtime",
        )
        entries: list = []
        for card in ((data.get("data") or {}).get("cards")) or []:
            entries.extend(self._flatten(card.get("content") or []))
        items: list[Hotspot] = []
        for e in entries[:MAX_ITEMS]:
            title = (e.get("word") or "").strip()
            if not title:
                continue
            hot = e.get("hotScore")
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url=e.get("url") or "",
                    rank=len(items) + 1,
                    heat=int(hot) if hot and str(hot).isdigit() else None,
                )
            )
        return items


class GoogleTrendsSource:
    name = "google-trends"
    region = "global"

    def fetch(self) -> list[Hotspot]:
        text = fetch_text(
            "https://trends.google.com/trending/rss?geo=US",
            ua=CN_UA,
        )
        root = ElementTree.fromstring(text)
        items: list[Hotspot] = []
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            if not title:
                continue
            traffic = ""
            for child in item:
                if child.tag.endswith("approx_traffic") and child.text:
                    traffic = child.text
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url=(item.findtext("link") or "").strip(),
                    rank=len(items) + 1,
                    heat=parse_heat(traffic.replace("+", "").replace(",", "")),
                )
            )
            if len(items) >= MAX_ITEMS:
                break
        return items


class HackerNewsSource:
    name = "hackernews"
    region = "global"

    def fetch(self) -> list[Hotspot]:
        data = fetch_json(
            "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30",
            ua=CN_UA,
        )
        items: list[Hotspot] = []
        for h in data.get("hits") or []:
            title = (h.get("title") or "").strip()
            if not title:
                continue
            url = h.get("url") or (
                f"https://news.ycombinator.com/item?id={h['objectID']}"
                if h.get("objectID")
                else ""
            )
            items.append(
                Hotspot(
                    platform=self.name,
                    title=title,
                    url=url,
                    rank=len(items) + 1,
                    heat=h.get("points"),
                )
            )
            if len(items) >= MAX_ITEMS:
                break
        return items


def direct_sources() -> list:
    return [
        WeiboSource(),
        BilibiliSource(),
        ZhihuSource(),
        BaiduSource(),
        GoogleTrendsSource(),
        HackerNewsSource(),
    ]
