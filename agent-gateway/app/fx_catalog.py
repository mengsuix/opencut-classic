"""特效组件目录：vendor 在 agent-gateway/registry/components/ 的 236 个
HyperFrames component（自包含 HTML+CSS+JS 片段）的本地检索与取用。

零网络：启动后首次访问时扫描 registry-item.json 建索引，snippet 按需读文件。
更新库 = 重跑 scripts/vendor_fx_registry.py。
"""

import json
import logging
import threading
from pathlib import Path

logger = logging.getLogger("agent-gateway.fx_catalog")

REGISTRY_DIR = Path(__file__).resolve().parent.parent / "registry" / "components"

# 单次返回给模型的 snippet 大小上限（片段设计上都只有几 KB，超了说明异常）
MAX_SNIPPET_BYTES = 64 * 1024

_index: list[dict] | None = None
_lock = threading.Lock()


def _load_index() -> list[dict]:
    global _index
    with _lock:
        if _index is not None:
            return _index
        items: list[dict] = []
        if REGISTRY_DIR.is_dir():
            for item_dir in sorted(REGISTRY_DIR.iterdir()):
                meta_path = item_dir / "registry-item.json"
                if not item_dir.is_dir() or not meta_path.is_file():
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as e:
                    logger.warning(f"跳过损坏的组件元数据 {item_dir.name}: {e}")
                    continue
                files = meta.get("files") or []
                if not files:
                    continue
                items.append(
                    {
                        "name": meta.get("name") or item_dir.name,
                        "title": meta.get("title") or "",
                        "description": meta.get("description") or "",
                        "tags": meta.get("tags") or [],
                        "variables": [
                            {
                                "id": v.get("id"),
                                "type": v.get("type"),
                                "label": v.get("label") or "",
                                "default": v.get("default"),
                                **({"options": [o.get("value") for o in v.get("options") or []]} if v.get("options") else {}),
                            }
                            for v in (meta.get("variables") or [])
                        ],
                        "_dir": item_dir,
                        "_snippet": Path(files[0]["path"]).name,
                    }
                )
        _index = items
        logger.info(f"特效组件索引就绪: {len(items)} 个")
        return _index


def search(query: str, limit: int = 8) -> list[dict]:
    """按 name/tags/title/description 打分检索，返回摘要列表（不含 snippet 正文）"""
    tokens = [t.lower() for t in query.split() if t.strip()]
    if not tokens:
        return []
    scored: list[tuple[int, dict]] = []
    for item in _load_index():
        name = item["name"].lower()
        title = item["title"].lower()
        desc = item["description"].lower()
        tags = [t.lower() for t in item["tags"]]
        score = 0
        for token in tokens:
            if token == name:
                score += 100
            elif token in name:
                score += 50
            if token in tags:
                score += 40
            elif any(token in t for t in tags):
                score += 20
            if token in title:
                score += 15
            if token in desc:
                score += 5
        if score:
            scored.append(
                (
                    score,
                    {
                        "name": item["name"],
                        "title": item["title"],
                        "description": item["description"],
                        "tags": item["tags"],
                        "variables": item["variables"],
                    },
                )
            )
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:limit]]


def get(name: str) -> dict | None:
    """按名取组件完整内容（元数据 + snippet 原文）；不存在返回 None"""
    for item in _load_index():
        if item["name"] != name:
            continue
        snippet_path = item["_dir"] / item["_snippet"]
        try:
            if snippet_path.stat().st_size > MAX_SNIPPET_BYTES:
                return {"name": name, "error": "snippet 超出大小上限"}
            snippet = snippet_path.read_text(encoding="utf-8")
        except OSError as e:
            return {"name": name, "error": f"snippet 读取失败: {e}"}
        return {
            "name": item["name"],
            "title": item["title"],
            "description": item["description"],
            "tags": item["tags"],
            "variables": item["variables"],
            "snippet": snippet,
            "usage": (
                "把 snippet 的 markup/CSS/JS 揉进你正在写的完整 HTML（变量值直接写死；"
                "文本类变量可改映射成 data-param 槽位保持可编辑；动画需自行接入 "
                'window.__timelines["main"] 契约）。'
            ),
        }
    return None
