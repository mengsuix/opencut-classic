#!/bin/bash
# ================================================================
# opencut 一键部署（链路复用 infer-web 基础设施）
#
#   本地 Mac → rsync 源码到 x86 开发机构建 amd64 镜像 → 推 CCR
#   → 生产服务器拉镜像 docker compose 启动
#
# 用法:
#   bash deploy/deploy.sh          # 全量部署（自动判断首次 init / 日常 update）
#   bash deploy/deploy.sh web      # 仅更新 web
#   bash deploy/deploy.sh gateway  # 仅更新 gateway
#   bash deploy/deploy.sh sync     # 仅同步配置（compose/env/migrations），不动服务
#   bash deploy/deploy.sh status   # 查看远端状态
#
# 前置:
#   cp deploy/env.example deploy/env  并填写（REMOTE_PASS / CCR_PASSWORD / DEEPSEEK_API_KEY）
#   未设 OPENCUT_REMOTE_HOST/PASS 时自动回退复用 infer-web 的 INFER_W_REMOTE_HOST/PASS
# ================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENV_FILE="$SCRIPT_DIR/env"
if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
fi

REMOTE_HOST="${OPENCUT_REMOTE_HOST:-${INFER_W_REMOTE_HOST:-}}"
REMOTE_PASS="${OPENCUT_REMOTE_PASS:-${INFER_W_REMOTE_PASS:-}}"
if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_PASS" ]; then
    echo "[ERROR] 请在 deploy/env 设置 OPENCUT_REMOTE_HOST / OPENCUT_REMOTE_PASS（或复用 INFER_W_REMOTE_HOST/PASS）" >&2
    exit 1
fi
export SSHPASS="$REMOTE_PASS"

# 对外地址：缺省按服务器 IP 推导（换域名时改 deploy/env 并重新构建 web 镜像）
SITE_URL="${OPENCUT_SITE_URL:-http://${REMOTE_HOST}:3100}"
GATEWAY_URL="${OPENCUT_GATEWAY_URL:-http://${REMOTE_HOST}:8787}"

# CCR 区域：与 infer-web 同规则，154.9.254.* 走美国仓库
REGION="${OPENCUT_CCR_REGION:-}"
if [ -z "$REGION" ]; then
    case "$REMOTE_HOST" in
        154.9.254.*) REGION="us" ;;
        *)           REGION="cn" ;;
    esac
fi

# 连接配置（与 infer-web 同一台开发机/服务器）
DEV_HOST="9.135.96.128"
DEV_PORT="36000"
DEV_USER="suixmeng"
DEV_KEY="$HOME/.ssh/9.135.96.128_rsa"
DEV_PROJECT_DIR="/data/home/suixmeng/opencut-classic"
REMOTE_DIR="/root/opencut"
REMOTE_USER="root"
REMOTE_PORT="38027"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

on_error() {
    local status=$?
    log_error "命令失败（退出码 ${status}），位置：${BASH_SOURCE[1]}:${BASH_LINENO[0]}"
    exit "$status"
}
cleanup() {
    local status=$?
    rm -f -- "${TMP_COMPOSE:-}" "${TMP_ENV:-}"
    return "$status"
}
trap on_error ERR
trap cleanup EXIT

if command -v /opt/homebrew/bin/rsync &>/dev/null; then
    RSYNC="/opt/homebrew/bin/rsync"
else
    RSYNC="rsync"
fi

dev_ssh() {
    ssh -i "$DEV_KEY" -p "$DEV_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$DEV_USER@$DEV_HOST" "sg docker -c \"$*\""
}

REMOTE_SSH_OPTS=(
    -p "$REMOTE_PORT"
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
    -o ConnectTimeout=15 -o ConnectionAttempts=1
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
)
REMOTE_SCP_OPTS=(-P "$REMOTE_PORT" "${REMOTE_SSH_OPTS[@]:1}")

remote_ssh() {
    sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

# ================================================================
# 远端部署逻辑（heredoc 发送到服务器执行）
# ================================================================
run_remote_deploy() {
    local mode="$1"
    remote_ssh "bash -s" "$mode" "$REGION" "$CCR_USERNAME" "$CCR_PASSWORD" << 'REMOTE_DEPLOY'
set -euo pipefail
mode="$1"; region="$2"; ccr_user="$3"; ccr_pass="$4"
cd /root/opencut

if ! docker compose version &>/dev/null; then
    echo "[ERROR] docker compose 不可用"; exit 1
fi

# 服务器侧只需 env 文件里的变量（compose 插值 + env_file）
set -a; . ./deploy/env; set +a

login_domain="ccr.ccs.tencentyun.com"
[ "$region" = "us" ] && login_domain="uswccr.ccs.tencentyun.com"
echo "[INFO] 登录 CCR ($login_domain)..."
echo "$ccr_pass" | docker login "$login_domain" --username="$ccr_user" --password-stdin > /dev/null

COMPOSE="docker compose --env-file deploy/env -f deploy/docker-compose.yml"

wait_healthy() {
    local container="$1"; local max_wait="${2:-120}"; local waited=0
    while [ $waited -lt $max_wait ]; do
        local status
        status=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' 2>/dev/null || echo "unknown")
        [ "$status" = "healthy" ] && return 0
        sleep 3; waited=$((waited + 3))
    done
    echo "[ERROR] $container 健康检查超时 (${max_wait}s)"
    docker logs --tail=30 "$container" 2>/dev/null || true
    return 1
}

apply_migrations() {
    # 幂等：sessions 表已存在则跳过（drizzle 初始迁移只跑一次）
    local exists
    exists=$(docker exec opencut-db psql -U opencut -d opencut -tAc "SELECT to_regclass('public.sessions')" | tr -d '[:space:]')
    if [ "$exists" = "sessions" ]; then
        echo "[INFO] 数据库表已存在，跳过迁移"
        return 0
    fi
    echo "[INFO] 应用 drizzle 初始迁移..."
    for f in deploy/migrations/*.sql; do
        echo "[INFO]   -> $f"
        docker exec -i opencut-db psql -U opencut -d opencut -v ON_ERROR_STOP=1 < "$f" > /dev/null
    done
    echo "[OK] 迁移完成"
}

case "$mode" in
    init)
        echo "[INFO] 首次部署..."
        $COMPOSE pull
        $COMPOSE up -d db
        wait_healthy opencut-db 90
        apply_migrations
        $COMPOSE up -d redis serverless-redis-http
        wait_healthy opencut-redis 60
        $COMPOSE up -d web gateway
        wait_healthy opencut-web 180
        wait_healthy opencut-gateway 120
        ;;
    update)
        echo "[INFO] 全量更新..."
        $COMPOSE pull web gateway
        $COMPOSE up -d web gateway
        wait_healthy opencut-web 180
        wait_healthy opencut-gateway 120
        ;;
    web|gateway)
        echo "[INFO] 更新 $mode..."
        $COMPOSE pull "$mode"
        $COMPOSE up -d "$mode"
        wait_healthy "opencut-$mode" 180
        ;;
esac

echo "[INFO] 清理未使用的历史镜像..."
docker image prune -af | tail -1 || true
REMOTE_DEPLOY
}

# ================================================================
# 主流程
# ================================================================
DEPLOY_MODE="${1:-auto}"

log_info "================================================="
log_info "      opencut 一键部署"
log_info "      开发机构建: ${DEV_USER}@${DEV_HOST}:${DEV_PORT}"
log_info "      生产服务器: ${REMOTE_HOST}  (CCR: ${REGION})"
log_info "      站点: ${SITE_URL}  Gateway: ${GATEWAY_URL}"
log_info "      模式: ${DEPLOY_MODE}"
log_info "================================================="

if [ "$DEPLOY_MODE" != "sync" ] && [ "$DEPLOY_MODE" != "status" ]; then
    # Step 1: 同步代码到开发机
    log_info "Step 1/4: 同步代码到开发机..."
    $RSYNC -avz --delete \
        -e "ssh -i $DEV_KEY -p $DEV_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
        --exclude='.git' \
        --exclude='node_modules' \
        --exclude='.next' \
        --exclude='.turbo' \
        --exclude='.venv' \
        --exclude='__pycache__' \
        --exclude='*.pyc' \
        --exclude='rust/target' \
        --exclude='data/' \
        --exclude='notes/' \
        --exclude='deploy/env' \
        --exclude='agent-gateway/data/' \
        "$PROJECT_DIR/" \
        "$DEV_USER@$DEV_HOST:$DEV_PROJECT_DIR/"
    log_ok "代码同步完成"

    # Step 2: 开发机构建并推送（密钥经命令行环境注入，不落开发机磁盘文件）
    log_info "Step 2/4: 构建并推送镜像到 CCR ($REGION)..."
    BUILD_TARGET="all"
    [ "$DEPLOY_MODE" = "web" ] && BUILD_TARGET="web"
    [ "$DEPLOY_MODE" = "gateway" ] && BUILD_TARGET="gateway"
    dev_ssh "cd $DEV_PROJECT_DIR && OPENCUT_CCR_REGION=$REGION CCR_USERNAME='$CCR_USERNAME' CCR_PASSWORD='$CCR_PASSWORD' OPENCUT_SITE_URL='$SITE_URL' OPENCUT_GATEWAY_URL='$GATEWAY_URL' NEXT_PUBLIC_MARBLE_API_URL='${NEXT_PUBLIC_MARBLE_API_URL:-https://api.marblecms.com}' MARBLE_WORKSPACE_KEY='${MARBLE_WORKSPACE_KEY:-build-placeholder}' FREESOUND_CLIENT_ID='${FREESOUND_CLIENT_ID:-}' FREESOUND_API_KEY='${FREESOUND_API_KEY:-}' bash deploy/build_push.sh $BUILD_TARGET"
    log_ok "镜像构建推送完成"
fi

if [ "$DEPLOY_MODE" = "status" ]; then
    remote_ssh "cd $REMOTE_DIR && docker compose --env-file deploy/env -f deploy/docker-compose.yml ps && echo '' && docker compose --env-file deploy/env -f deploy/docker-compose.yml logs --tail=10 2>/dev/null || true"
    exit 0
fi

# Step 3: 同步配置文件到生产服务器
log_info "Step 3/4: 同步配置文件到服务器..."
: "${CCR_USERNAME:?deploy/env 缺少 CCR_USERNAME}" "${CCR_PASSWORD:?deploy/env 缺少 CCR_PASSWORD}"

# 按区域生成服务器用的 compose（镜像地址 cn/us 互换）
TMP_COMPOSE="$(mktemp)"
if [ "$REGION" = "us" ]; then
    sed -e 's|ccr\.ccs\.tencentyun\.com/infer-web/opencut-web:latest|uswccr.ccs.tencentyun.com/infer-w/opencut:web-latest|g' \
        -e 's|ccr\.ccs\.tencentyun\.com/infer-web/opencut-gateway:latest|uswccr.ccs.tencentyun.com/infer-w/opencut:gateway-latest|g' \
        deploy/docker-compose.yml > "$TMP_COMPOSE"
else
    sed -e 's|uswccr\.ccs\.tencentyun\.com/infer-w/opencut:web-latest|ccr.ccs.tencentyun.com/infer-web/opencut-web:latest|g' \
        -e 's|uswccr\.ccs\.tencentyun\.com/infer-w/opencut:gateway-latest|ccr.ccs.tencentyun.com/infer-web/opencut-gateway:latest|g' \
        deploy/docker-compose.yml > "$TMP_COMPOSE"
fi

# 服务器 env = 本地 deploy/env + 推导出的对外地址（容器 env_file 直接消费）
TMP_ENV="$(mktemp)"
cat "$ENV_FILE" > "$TMP_ENV"
{
    echo "OPENCUT_SITE_URL=$SITE_URL"
    echo "OPENCUT_GATEWAY_URL=$GATEWAY_URL"
} >> "$TMP_ENV"

remote_ssh "mkdir -p $REMOTE_DIR/deploy/migrations"
sshpass -e scp "${REMOTE_SCP_OPTS[@]}" "$TMP_COMPOSE" "${REMOTE_USER}@${REMOTE_HOST}:$REMOTE_DIR/deploy/docker-compose.yml"
sshpass -e scp "${REMOTE_SCP_OPTS[@]}" "$TMP_ENV" "${REMOTE_USER}@${REMOTE_HOST}:$REMOTE_DIR/deploy/env"
remote_ssh "chmod 600 $REMOTE_DIR/deploy/env"
$RSYNC -avz --delete -e "sshpass -e ssh ${REMOTE_SSH_OPTS[*]}" \
    apps/web/migrations/ "${REMOTE_USER}@${REMOTE_HOST}:$REMOTE_DIR/deploy/migrations/"
log_ok "配置同步完成"

# Step 4: 远程部署
if [ "$DEPLOY_MODE" = "sync" ]; then
    log_ok "同步模式：完成（未变更服务）"
    exit 0
fi

log_info "Step 4/4: 远程部署..."
if [ "$DEPLOY_MODE" = "auto" ]; then
    HAS_WEB=$(remote_ssh "docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^opencut-web$' && echo yes || echo no")
    if [ "$HAS_WEB" = "yes" ]; then
        run_remote_deploy update
    else
        run_remote_deploy init
    fi
else
    run_remote_deploy "$DEPLOY_MODE"
fi

echo ""
log_ok "================================================="
log_ok "       部署完成！"
log_ok "       编辑器:  $SITE_URL"
log_ok "       Gateway: $GATEWAY_URL/health"
log_ok "       注意: 云安全组需放行 3100/8787"
log_ok "================================================="
