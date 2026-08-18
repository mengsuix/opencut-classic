#!/usr/bin/env bash
# 根据目录素材和可选需求生成详细视频剪辑方案
# 用法: ./edit-plan.sh <素材目录> [--requirements 需求.txt] [--output-dir 输出目录]
set -e
cd "$(dirname "$0")"
exec .venv/bin/python -m pipeline.cli edit-plan "$@"
