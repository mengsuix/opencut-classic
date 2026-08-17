from __future__ import annotations


def is_blacklisted(title: str, blacklist: list[str]) -> bool:
    t = title.lower()
    return any(w and w.lower() in t for w in blacklist)


def match_topics(title: str, topics: list[dict]) -> list[str]:
    t = title.lower()
    return [
        topic["name"]
        for topic in topics
        if any(k and k.lower() in t for k in topic.get("keywords", []))
    ]
