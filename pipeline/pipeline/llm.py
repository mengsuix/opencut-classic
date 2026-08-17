from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "llm.json"

DEFAULTS = {
    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "api_key_env": "DASHSCOPE_API_KEY",
    "model": "qwen-plus",
    "temperature": 0.7,
    "timeout": 120,
}

_cache: dict | None = None


def load_config() -> dict:
    global _cache
    if _cache is None:
        cfg = dict(DEFAULTS)
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except OSError:
            pass
        _cache = cfg
    return _cache


def chat(
    messages: list[dict],
    *,
    model: str | None = None,
    temperature: float | None = None,
    max_tokens: int = 4096,
) -> str:
    """调用 OpenAI 兼容的 chat completions 接口，返回文本内容。"""
    cfg = load_config()
    api_key = os.environ.get(cfg["api_key_env"], "")
    if not api_key and cfg["api_key_env"] != "OLLAMA_NO_KEY":
        raise RuntimeError(
            f"缺少 API key：请 export {cfg['api_key_env']}=<your-key>，"
            f"或在 config/llm.json 中改用其他 provider"
        )
    payload = {
        "model": model or cfg["model"],
        "messages": messages,
        "temperature": cfg["temperature"] if temperature is None else temperature,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=cfg["timeout"]) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def extract_json(text: str):
    """从 LLM 输出中提取 JSON（容忍 ```json 包裹和前后多余文字）。"""
    s = text.strip()
    if s.startswith("```"):
        first_nl = s.find("\n")
        s = s[first_nl + 1 :] if first_nl != -1 else s
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3].strip()
    start_cands = [(s.find("["), "["), (s.find("{"), "{")]
    start_cands = [(i, c) for i, c in start_cands if i != -1]
    if not start_cands:
        raise ValueError(f"LLM 输出中未找到 JSON：{text[:200]}")
    start, open_ch = min(start_cands)
    close_ch = "]" if open_ch == "[" else "}"
    end = s.rfind(close_ch)
    if end <= start:
        raise ValueError(f"LLM 输出 JSON 不完整：{text[:200]}")
    return json.loads(s[start : end + 1])


def chat_json(messages: list[dict], **kwargs):
    return extract_json(chat(messages, **kwargs))
