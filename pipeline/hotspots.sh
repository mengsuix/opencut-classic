#!/usr/bin/env bash
# 抓取热点榜单，终端打印 Top 列表
# 用法: ./hotspots.sh [hotspots 选项...]
# 例:   ./hotspots.sh
#       ./hotspots.sh --mode topics --limit 30
set -e
cd "$(dirname "$0")"
exec .venv/bin/python -m pipeline.cli hotspots "$@"
