from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .hotspots.direct import direct_sources
from .hotspots.fetch import fetch_all, hotspot_to_dict
from .hotspots.filter import is_blacklisted, match_topics
from .hotspots.ranking import rank_hotspots
from .hotspots.tophub import tophub_sources
from .edit_plan import EditPlanInputError, run_edit_plan
from .workflow import run_selected_plans, save_workflow_summary

PIPELINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = PIPELINE_DIR / "config"
DATA_DIR = PIPELINE_DIR / "data" / "hotspots"


def load_context() -> str:
    return (CONFIG_DIR / "context.md").read_text(encoding="utf-8")


def latest_file(subdir: str) -> Path:
    files = sorted((PIPELINE_DIR / "data" / subdir).glob("*.json"))
    if not files:
        raise FileNotFoundError(
            f"data/{subdir}/ 下没有数据文件，请先运行 hotspots 阶段"
        )
    return files[-1]


def load_items(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["items"]


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
    ranked = rank_hotspots(items, stats)
    out = [it for it in ranked if not is_blacklisted(it.title, blacklist)]
    if args.mode == "topics":
        out = [it for it in out if it.matched_topics]

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
        print(f"  [{it.id}] {it.platform}{cross}{topic}  {it.title}")
    print(f"\n已保存: {fname}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    src = Path(args.input) if args.input else latest_file("hotspots")
    selected_ids = []
    for value in args.hotspot_id + args.hotspot_ids:
        selected_ids.extend(part.strip() for part in value.split(",") if part.strip())
    selected_ids = list(dict.fromkeys(selected_ids))
    if not selected_ids:
        print("必须至少指定一个热点 ID，例如：--hotspot-id weibo:abcdef1234")
        return 2

    print(f"输入: {src}")
    items = load_items(src)
    by_id = {item.get("id"): item for item in items if item.get("id")}
    missing = [hotspot_id for hotspot_id in selected_ids if hotspot_id not in by_id]
    if missing:
        print(f"找不到热点 ID：{', '.join(missing)}")
        return 2

    selected = [by_id[hotspot_id] for hotspot_id in selected_ids]
    context = load_context()
    results, failures = run_selected_plans(
        selected,
        context,
        source_file=src,
        max_attempts=args.max_attempts,
        timeout=args.timeout,
    )
    path = save_workflow_summary(results, failures, src)
    for result in results:
        plan = result["plan"]
        hotspot = result["hotspot"]
        print(f"\n=== 策划 [{hotspot['id']}] {plan.get('title', '')} ===")
        print(f"  角度: {plan.get('angle', '')}")
        print(f"  钩子: {plan.get('hook', '')}")
        print(f"  时长: {plan.get('duration', '?')}s  平台: {plan.get('platform_fit', '?')}  素材: {len(plan.get('assets', []))} 项")
    if failures:
        print(f"\n失败 {len(failures)} 条；阶段中间产物和错误已保存到 data/plans/<hotspot_id>/")
    print(f"\n已保存: {path}")
    return 1 if failures else 0


def cmd_edit_plan(args: argparse.Namespace) -> int:
    try:
        summary = run_edit_plan(
            args.input_dir,
            requirements=args.requirements,
            output_dir=args.output_dir,
            max_attempts=args.max_attempts,
            timeout=args.timeout,
            max_agent_input_bytes=args.max_agent_input_bytes,
        )
    except EditPlanInputError as exc:
        print(f"输入错误：{exc}", file=sys.stderr)
        return 2
    print(f"状态: {summary['status']}  素材: {summary['asset_count']}  跳过: {summary['skipped_count']}")
    print(f"尝试次数: {summary['attempts']}")
    if summary["errors"]:
        print(f"错误: {len(summary['errors'])} 项", file=sys.stderr)
    input_path = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser() if args.output_dir else input_path.parent / f"{input_path.name}-video-plan"
    print(f"已保存: {output_dir.resolve()}")
    return 0 if summary["status"] == "succeeded" else 1


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

    pl = sub.add_parser("plan", help="对人工选择的热点运行解构、评委、策划三阶段")
    pl.add_argument("--input", default=None, help="指定 hotspots JSON 文件，默认取最新")
    pl.add_argument("--hotspot-id", action="append", default=[], help="要策划的热点 ID，可重复指定")
    pl.add_argument("--hotspot-ids", action="append", default=[], help="逗号分隔的热点 ID")
    pl.add_argument("--max-attempts", type=int, default=3, help="每个阶段最多尝试次数")
    pl.add_argument("--timeout", type=int, default=600, help="单次 tcodex 调用超时秒数")
    pl.set_defaults(func=cmd_plan)

    ep = sub.add_parser("edit-plan", help="根据目录素材和需求生成详细视频剪辑方案")
    ep.add_argument("input_dir", help="素材目录；目录内普通文件都会进入扫描清单")
    ep.add_argument("--requirements", default=None, help="可选 UTF-8 需求文件")
    ep.add_argument("--output-dir", default=None, help="输出目录，默认在素材目录旁生成")
    ep.add_argument("--max-attempts", type=int, default=3, help="Agent 最多尝试次数")
    ep.add_argument("--timeout", type=int, default=600, help="单次 tcodex 调用超时秒数")
    ep.add_argument("--max-agent-input-bytes", type=int, default=262144, help="Agent 输入最大 UTF-8 字节数")
    ep.set_defaults(func=cmd_edit_plan)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
