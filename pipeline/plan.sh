#!/usr/bin/env bash
# 对选定的热点生成策划案（解构→评委→策划三阶段）
# 用法: ./plan.sh <热点ID>... [plan 选项...]   （ID 在前，选项在后）
# 例:   ./plan.sh weibo:a9ea991ed3
#       ./plan.sh weibo:a9ea991ed3 toutiao:60b67f4623
#       ./plan.sh weibo:a9ea991ed3 --input data/hotspots/xxx.json
set -e
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  echo "用法: $0 <热点ID>... [plan 选项...]   例: $0 weibo:a9ea991ed3" >&2
  exit 2
fi

args=()
for id in "$@"; do
  case "$id" in --*) break ;; esac
  args+=(--hotspot-id "$id")
done

exec .venv/bin/python -m pipeline.cli plan "${args[@]}" "$@"
