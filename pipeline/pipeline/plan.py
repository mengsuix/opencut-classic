from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .llm import chat_json
from .score import load_context

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"

PLAN_PROMPT = """你是资深短视频策划。基于我的实际场景，为下面的热点写一条推广视频策划案。

# 我的实际场景
{context}

# 热点
标题：{title}
平台：{platform}{also_on}
热度：{heat}
链接：{url}
打分理由：{reason}

# 硬性制作约束（必须遵守）
- 没有实拍条件：只有一台电脑，无法拍摄任何实景、真人出镜
- 画面素材只能用这四类，每个素材必须标注类型：
  screen_record=屏幕/软件操作录屏；web_image=网络可合法获取的图片/截图（需注明搜索关键词或来源）；ai_image=AI 文生图（需给出可用的生图提示词）；ai_video=AI 文生视频片段（需给出提示词）；text_card=文字卡片/数据动效
- 配音用 AI 语音，不出现真人原声

# 输出
严格输出一个 JSON 对象，不要输出任何其他文字：
{{
  "title": "视频标题（带钩子）",
  "angle": "结合角度：这个热点如何自然引出产品，一句话",
  "hook": "前 3 秒钩子文案",
  "script": "完整口播文案（配合时长，口语化）",
  "style": "内容风格与节奏描述",
  "duration": 预估时长秒数,
  "platform_fit": "最适合发布的平台",
  "assets": [
    {{"type": "素材类型", "desc": "画面内容描述", "source": "获取方式/搜索关键词/AI提示词"}}
  ]
}}"""


def make_plan(item: dict, context: str) -> dict:
    also_on = f"（同榜：{'、'.join(item['also_on'])}）" if item.get("also_on") else ""
    prompt = PLAN_PROMPT.format(
        context=context,
        title=item["title"],
        platform=item["platform"],
        also_on=also_on,
        heat=item.get("heat") or "未知",
        url=item.get("url") or "",
        reason=item.get("reason", ""),
    )
    plan = chat_json([{"role": "user", "content": prompt}], max_tokens=4096)
    plan["hotspot"] = {
        "id": item.get("id"),
        "title": item["title"],
        "platform": item["platform"],
        "url": item.get("url"),
        "score": item.get("score"),
    }
    return plan


def make_plans(
    items: list[dict], context: str, count: int, min_score: int
) -> list[dict]:
    candidates = [it for it in items if it.get("score", 0) >= min_score][:count]
    plans = []
    for i, it in enumerate(candidates):
        print(f"  策划中 {i + 1}/{len(candidates)}: {it['title'][:30]}")
        plans.append(make_plan(it, context))
    return plans


def save_plans(plans: list[dict], source_file: Path) -> Path:
    out_dir = DATA_DIR / "plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    path = out_dir / f"{ts}.json"
    path.write_text(
        json.dumps(
            {"fetchedAt": ts, "source": source_file.name, "total": len(plans), "plans": plans},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
