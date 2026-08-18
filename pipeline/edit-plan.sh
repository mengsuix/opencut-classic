#!/usr/bin/env bash
# 根据目录素材和需求生成详细视频剪辑方案
# 用法: ./edit-plan.sh 需求.txt [--input-dir 素材目录] [--output-dir 输出目录]
#                      [--stop-after 阶段] [--approve | --feedback "意见" [--revise 阶段]]
# 需求文件必填；不传素材目录表示没有已有参考素材
# --stop-after 在指定阶段后暂停等待人工审批；--approve 批准继续；--feedback 按意见重跑目标阶段（旧结果归档 history/）
set -e
cd "$(dirname "$0")"
exec .venv/bin/python -m pipeline.cli edit-plan "$@"
