#!/bin/bash
# ================================================================
# opencut 构建 + 推送腾讯云 CCR（在 x86 开发机上原生构建，由 deploy.sh 远程触发）
#
# 用法:
#   bash deploy/build_push.sh            # web + gateway
#   bash deploy/build_push.sh web
#   bash deploy/build_push.sh gateway
#
# 必需环境变量（deploy.sh 会注入）:
#   OPENCUT_CCR_REGION   cn|us
#   CCR_USERNAME / CCR_PASSWORD
#   OPENCUT_SITE_URL / OPENCUT_GATEWAY_URL   （NEXT_PUBLIC_* 构建期烘焙）
# 可选: FREESOUND_CLIENT_ID / FREESOUND_API_KEY / MARBLE_WORKSPACE_KEY
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

REGION="${OPENCUT_CCR_REGION:?缺少 OPENCUT_CCR_REGION}"
: "${CCR_USERNAME:?缺少 CCR_USERNAME}" "${CCR_PASSWORD:?缺少 CCR_PASSWORD}"
: "${OPENCUT_SITE_URL:?缺少 OPENCUT_SITE_URL}" "${OPENCUT_GATEWAY_URL:?缺少 OPENCUT_GATEWAY_URL}"

case "$REGION" in
    cn)
        WEB_TAG="ccr.ccs.tencentyun.com/infer-web/opencut-web:latest"
        GATEWAY_TAG="ccr.ccs.tencentyun.com/infer-web/opencut-gateway:latest"
        LOGIN_DOMAIN="ccr.ccs.tencentyun.com"
        ;;
    us)
        WEB_TAG="uswccr.ccs.tencentyun.com/infer-w/opencut:web-latest"
        GATEWAY_TAG="uswccr.ccs.tencentyun.com/infer-w/opencut:gateway-latest"
        LOGIN_DOMAIN="uswccr.ccs.tencentyun.com"
        ;;
    *)
        log_error "OPENCUT_CCR_REGION 必须是 cn 或 us，当前: $REGION"
        exit 1
        ;;
esac

log_info "登录 CCR ($REGION: $LOGIN_DOMAIN)..."
echo "$CCR_PASSWORD" | docker login "$LOGIN_DOMAIN" --username="$CCR_USERNAME" --password-stdin

build_web() {
    log_info "=== 构建 + 推送 web（x86 原生）==="
    log_info "NEXT_PUBLIC_SITE_URL=$OPENCUT_SITE_URL  NEXT_PUBLIC_AGENT_GATEWAY_URL=$OPENCUT_GATEWAY_URL"
    docker buildx build \
        -f deploy/../apps/web/Dockerfile \
        --build-arg NEXT_PUBLIC_SITE_URL="$OPENCUT_SITE_URL" \
        --build-arg NEXT_PUBLIC_AGENT_GATEWAY_URL="$OPENCUT_GATEWAY_URL" \
        --build-arg NEXT_PUBLIC_MARBLE_API_URL="${NEXT_PUBLIC_MARBLE_API_URL:-https://api.marblecms.com}" \
        --build-arg MARBLE_WORKSPACE_KEY="${MARBLE_WORKSPACE_KEY:-build-placeholder}" \
        --build-arg FREESOUND_CLIENT_ID="${FREESOUND_CLIENT_ID:-}" \
        --build-arg FREESOUND_API_KEY="${FREESOUND_API_KEY:-}" \
        -t "$WEB_TAG" \
        --push \
        .
    log_ok "web 构建推送完成: $WEB_TAG"
}

build_gateway() {
    log_info "=== 构建 + 推送 gateway（x86 原生）==="
    docker buildx build \
        -f deploy/Dockerfile.gateway \
        -t "$GATEWAY_TAG" \
        --push \
        .
    log_ok "gateway 构建推送完成: $GATEWAY_TAG"
}

TARGET="${1:-all}"
case "$TARGET" in
    all)     build_web; build_gateway ;;
    web)     build_web ;;
    gateway) build_gateway ;;
    *)       log_error "用法: $0 {all|web|gateway}"; exit 1 ;;
esac

log_ok "构建推送完成（$REGION）"
