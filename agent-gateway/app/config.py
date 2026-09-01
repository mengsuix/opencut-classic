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

# 模型提供商配置：通过 AGENT_PROVIDER 一键切换
_PROVIDER_CONFIGS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/anthropic",
        "api_key_env": "DEEPSEEK_API_KEY",
        "model": "deepseek-v4-flash-vision-exp",
        "subagent_model": "deepseek-v4-flash",
    },
    "zhipu": {
        "base_url": "https://open.bigmodel.cn/api/anthropic",
        "api_key_env": "ZHIPU_API_KEY",
        "model": "glm-5.3-flash[1m]",
        "subagent_model": "glm-5.3-flash[1m]",
    },
}

AGENT_PROVIDER = os.environ.get("AGENT_PROVIDER", "deepseek").strip().lower()
if AGENT_PROVIDER not in _PROVIDER_CONFIGS:
    raise ValueError("AGENT_PROVIDER 必须是 deepseek 或 zhipu")

_provider_config = _PROVIDER_CONFIGS[AGENT_PROVIDER]
AGENT_MODEL = _provider_config["model"]
AGENT_HAIKU_MODEL = _provider_config["subagent_model"]
AGENT_BASE_URL = _provider_config["base_url"]
AGENT_AUTH_TOKEN = os.environ.get(_provider_config["api_key_env"], "")

AGENT_ENV = {
    "ANTHROPIC_BASE_URL": AGENT_BASE_URL,
    "ANTHROPIC_AUTH_TOKEN": AGENT_AUTH_TOKEN,
    "ANTHROPIC_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_SONNET_MODEL": AGENT_MODEL,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": AGENT_HAIKU_MODEL,
    "CLAUDE_CODE_SUBAGENT_MODEL": AGENT_HAIKU_MODEL,
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "API_TIMEOUT_MS": "3000000",
}

MAX_TURNS_PER_SESSION = 1000
IDLE_SESSION_SECONDS = float(os.environ.get("IDLE_SESSION_SECONDS", str(2 * 3600)))
IDLE_CLEANUP_INTERVAL_SECONDS = 600
