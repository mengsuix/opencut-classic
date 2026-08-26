#!/bin/bash
# 开发启动脚本。需要：
#   1. claude CLI 已安装（npm i -g @anthropic-ai/claude-code）
#   2. 环境变量：DATABASE_URL（与 apps/web 共享）、ANTHROPIC_AUTH_TOKEN（或 DEEPSEEK_KEY）
#   3. 可选：DEV_BYPASS_AUTH=true 跳过鉴权（仅本地调试）
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/uvicorn app.main:app --host "${GATEWAY_HOST:-127.0.0.1}" --port "${GATEWAY_PORT:-8787}" --reload
