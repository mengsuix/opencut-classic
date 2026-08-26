"""Agent Gateway 配置 - 全部通过环境变量覆盖"""

import os
from pathlib import Path

GATEWAY_HOST = os.environ.get("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.environ.get("GATEWAY_PORT", "8787"))

# CORS 放行的前端源
WEB_ORIGIN = os.environ.get("WEB_ORIGIN", "http://localhost:3000")

# Agent 会话数据目录（Claude CLI 的 CLAUDE_CONFIG_DIR、SQLite 默认位置）
AGENT_DATA_DIR = Path(
    os.environ.get("AGENT_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))
)

# ---------------------------------------------------------------------------
# 鉴权模式：
#   dev         — 直通，所有请求视为同一本地用户（默认，本地开发零依赖）
#   better_auth — 查 apps/web better-auth 的 PG sessions 表（apps/web 现状的过渡方案）
# 接入自己的鉴权时：在 auth.py 中新增一个 provider 并在此增加模式名。
# ---------------------------------------------------------------------------
AUTH_MODE = os.environ.get("AUTH_MODE", "dev")

# 自有表存储（必填，自动建库建表）：
#   mysql://user:pass@host:3306/opencut_agent  — 本地/线上 MySQL
#   postgres://... / postgresql://...          — 与 apps/web 共享的 PG（better_auth 模式必须）
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "mysql://root:password@127.0.0.1:3306/opencut_agent"
)

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
