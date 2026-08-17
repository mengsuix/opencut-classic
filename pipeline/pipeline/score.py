from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .llm import chat_json

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"


def load_context() -> str:
    path = PIPELINE_DIR / "config" / "context.md"
    return path.read_text(encoding="utf-8")


def latest_file(subdir: str) -> Path:
    files = sorted((DATA_DIR / subdir).glob("*.json"))
    if not files:
        raise FileNotFoundError(
            f"data/{subdir}/ 下没有数据文件，请先运行 hotspots（或 score）阶段"
        )
    return files[-1]


def load_items(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["items"]


SCORE_PROMPT = """你是推广视频选题筛选助手。

# 我的实际场景
{context}

# 任务
对下列热点逐条打分（0-10 整数），判断值不值得做成推广视频。打分维度：
1. 相关性：热点能否自然引出产品（硬蹭的给低分）
2. 可视频化：在我的制作条件下能否做出画面
3. 时效性：热度是否还在窗口期

# 热点列表（序号 | 平台 | 标题）
{items}

# 输出
严格输出 JSON 数组，每个元素 {{"i": 序号, "score": 分数, "reason": "一句话理由"}}，不要输出任何其他文字。"""


def score_items(
    items: list[dict], context: str, batch_size: int = 30
) -> list[dict]:
    """批量打分，返回带 score/reason 的条目列表（按分数降序）。"""
    scored: dict[int, dict] = {}
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        lines = "\n".join(
            f"{i + 1} | {it['platform']} | {it['title']}"
            for i, it in enumerate(batch)
        )
        prompt = SCORE_PROMPT.format(context=context, items=lines)
        results = chat_json(
            [{"role": "user", "content": prompt}], max_tokens=8192
        )
        for r in results:
            idx = int(r["i"]) - 1
            if 0 <= idx < len(batch):
                scored[start + idx] = {
                    "score": int(r["score"]),
                    "reason": str(r.get("reason", "")),
                }
        print(f"  已打分 {min(start + batch_size, len(items))}/{len(items)}")
    out = []
    for i, it in enumerate(items):
        if i in scored:
            out.append({**it, **scored[i]})
    out.sort(key=lambda x: -x["score"])
    return out


def save_result(scored: list[dict], source_file: Path) -> Path:
    out_dir = DATA_DIR / "scores"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    path = out_dir / f"{ts}.json"
    path.write_text(
        json.dumps(
            {
                "fetchedAt": ts,
                "source": source_file.name,
                "total": len(scored),
                "items": scored,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
