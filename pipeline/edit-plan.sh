#!/usr/bin/env bash
# 根据需求生成视频分镜脚本草稿（无输入素材）
# 用法: ./edit-plan.sh 需求.txt [--output-dir 输出目录]
set -e
cd "$(dirname "$0")"
exec .venv/bin/python -m pipeline.cli edit-plan "$@"
