"""Agent Gateway 配置 - 全部通过环境变量覆盖"""

import os
from pathlib import Path

GATEWAY_HOST = os.environ.get("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.environ.get("GATEWAY_PORT", "8787"))

# 与 apps/web 共享的 Postgres（better-auth 的 sessions 表用于鉴权）
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# CORS 放行的前端源
WEB_ORIGIN = os.environ.get("WEB_ORIGIN", "http://localhost:3000")

# Agent 会话数据目录（Claude CLI 的 CLAUDE_CONFIG_DIR、session 工作目录）
AGENT_DATA_DIR = Path(
    os.environ.get("AGENT_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))
)

# 开发模式：跳过鉴权（仅本地调试使用）
DEV_BYPASS_AUTH = os.environ.get("DEV_BYPASS_AUTH", "").lower() in ("1", "true", "yes")

# 模型配置：默认 DeepSeek（Anthropic 兼容端点），可用官方 Anthropic 覆盖
AGENT_MODEL = os.environ.get("AGENT_MODEL", "deepseek-v4-flash[1m]")

AGENT_ENV = {
    "ANTHROPIC_BASE_URL": os.environ.get(
        "ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic"
    ),
    "ANTHROPIC_AUTH_TOKEN": os.environ.get("ANTHROPIC_AUTH_TOKEN")
    or os.environ.get("DEEPSEEK_KEY", ""),
    "ANTHROPIC_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_SONNET_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ.get(
        "ANTHROPIC_HAIKU_MODEL", "deepseek-v4-flash"
    ),
    "CLAUDE_CODE_SUBAGENT_MODEL": os.environ.get(
        "ANTHROPIC_HAIKU_MODEL", "deepseek-v4-flash"
    ),
}

MAX_TURNS_PER_SESSION = 1000
IDLE_SESSION_SECONDS = float(os.environ.get("IDLE_SESSION_SECONDS", str(2 * 3600)))
IDLE_CLEANUP_INTERVAL_SECONDS = 600
