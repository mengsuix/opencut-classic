from __future__ import annotations

import json
import urllib.request


def fetch(
    url: str,
    *,
    ua: str,
    referer: str | None = None,
    timeout: float = 15.0,
) -> bytes:
    headers = {"User-Agent": ua}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_text(
    url: str,
    *,
    ua: str,
    referer: str | None = None,
    timeout: float = 15.0,
) -> str:
    return fetch(url, ua=ua, referer=referer, timeout=timeout).decode(
        "utf-8", errors="replace"
    )


def fetch_json(
    url: str,
    *,
    ua: str,
    referer: str | None = None,
    timeout: float = 15.0,
):
    return json.loads(fetch_text(url, ua=ua, referer=referer, timeout=timeout))
