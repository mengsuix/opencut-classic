from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .hotspots.direct import direct_sources
from .hotspots.fetch import fetch_all, hotspot_to_dict
from .hotspots.filter import is_blacklisted, match_topics
from .hotspots.tophub import tophub_sources
from .plan import make_plans, save_plans
from .score import latest_file, load_context, load_items, save_result, score_items

PIPELINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = PIPELINE_DIR / "config"
DATA_DIR = PIPELINE_DIR / "data" / "hotspots"


def load_config(name: str, fallback):
    try:
        return json.loads((CONFIG_DIR / name).read_text(encoding="utf-8"))
    except OSError:
        return fallback


def build_sources(provider: str, region: str) -> list:
    sources: list = []
    if provider != "tophub":
        sources.extend(direct_sources())
    if provider != "direct":
        nodes = load_config("tophub-nodes.json", [])
        sources.extend(tophub_sources(nodes))
    if region != "all":
        sources = [s for s in sources if s.region == region]
    return sources


def cmd_hotspots(args: argparse.Namespace) -> int:
    topics = load_config("topics.json", [])
    blacklist = load_config("blacklist.json", [])

    sources = build_sources(args.provider, args.region)
    if not sources:
        print("没有可用的源（检查 --provider/--region 或 config/tophub-nodes.json）")
        return 1

    items, stats = fetch_all(sources)

    for it in items:
        it.matched_topics = match_topics(it.title, topics)
    out = [it for it in items if not is_blacklisted(it.title, blacklist)]
    if args.mode == "topics":
        out = [it for it in out if it.matched_topics]
    out.sort(key=lambda it: (-len(it.also_on), it.rank))

    fetched_at = datetime.now(timezone.utc)
    result = {
        "mode": args.mode,
        "region": args.region,
        "provider": args.provider,
        "fetchedAt": fetched_at.isoformat(),
        "total": len(out),
        "stats": [s.to_dict() for s in stats],
        "items": [hotspot_to_dict(it) for it in out],
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fname = DATA_DIR / (fetched_at.strftime("%Y-%m-%dT%H-%M-%S") + ".json")
    fname.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n模式: {args.mode}  地区: {args.region}  来源: {args.provider}  候选: {len(out)} 条")
    for s in stats:
        if s.error:
            print(f"  [FAIL] {s.name}: {s.error}")
        else:
            print(f"  [ ok ] {s.name}: {s.count} 条")
    print(f"\nTop {min(args.limit, len(out))}:")
    for it in out[: args.limit]:
        cross = f" +[{','.join(it.also_on)}]" if it.also_on else ""
        topic = f" <{'/'.join(it.matched_topics)}>" if it.matched_topics else ""
        print(f"  {it.platform}{cross}{topic}  {it.title}")
    print(f"\n已保存: {fname}")
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    src = Path(args.input) if args.input else latest_file("hotspots")
    print(f"输入: {src}")
    items = load_items(src)
    context = load_context()
    print(f"候选 {len(items)} 条，LLM 打分中…")
    scored = score_items(items, context, batch_size=args.batch)
    path = save_result(scored, src)
    print(f"\nTop {min(args.limit, len(scored))}:")
    for it in scored[: args.limit]:
        print(f"  [{it['score']:>2}] {it['platform']}  {it['title']}  — {it['reason']}")
    print(f"\n已保存: {path}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    src = Path(args.input) if args.input else latest_file("scores")
    print(f"输入: {src}")
    items = load_items(src)
    context = load_context()
    plans = make_plans(items, context, count=args.count, min_score=args.min_score)
    if not plans:
        print("没有满足分数条件的热点（调低 --min-score 或检查打分结果）")
        return 1
    path = save_plans(plans, src)
    for i, p in enumerate(plans):
        print(f"\n=== 策划 {i + 1}: {p.get('title', '')} ===")
        print(f"  角度: {p.get('angle', '')}")
        print(f"  钩子: {p.get('hook', '')}")
        print(f"  时长: {p.get('duration', '?')}s  平台: {p.get('platform_fit', '?')}  素材: {len(p.get('assets', []))} 项")
    print(f"\n已保存: {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="pipeline", description="推广视频批量生产流水线")
    sub = parser.add_subparsers(dest="command", required=True)

    hot = sub.add_parser("hotspots", help="抓取热点榜单")
    hot.add_argument("--mode", choices=["full", "topics"], default="full",
                     help="full=全量候选池(供LLM打分) topics=仅保留命中订阅主题的热点")
    hot.add_argument("--provider", choices=["all", "direct", "tophub"], default="all",
                     help="direct=各平台官方接口 tophub=今日热榜聚合(覆盖抖音/头条) all=两者合并去重")
    hot.add_argument("--region", choices=["all", "cn", "global"], default="all")
    hot.add_argument("--limit", type=int, default=20, help="终端展示条数")
    hot.set_defaults(func=cmd_hotspots)

    sc = sub.add_parser("score", help="LLM 依据 config/context.md 给热点打分")
    sc.add_argument("--input", default=None, help="指定 hotspots JSON 文件，默认取最新")
    sc.add_argument("--batch", type=int, default=30, help="每批送评分条数")
    sc.add_argument("--limit", type=int, default=20, help="终端展示条数")
    sc.set_defaults(func=cmd_score)

    pl = sub.add_parser("plan", help="对高分热点逐条生成策划案")
    pl.add_argument("--input", default=None, help="指定 scores JSON 文件，默认取最新")
    pl.add_argument("--count", type=int, default=3, help="产出策划案条数")
    pl.add_argument("--min-score", type=int, default=6, help="入选最低分")
    pl.set_defaults(func=cmd_plan)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
