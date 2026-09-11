#!/bin/bash
# 非交互部署脚本（上游 deploy/install.sh 是交互式向导，本脚本用于脚本化部署）
#
# 用法：
#   export PUBLIC_URL='https://cloud.example.com'   # 必填，前后端共用的公网地址
#   export TELEGRAM_BOT_TOKEN='123456:ABC...'       # 必填，@BotFather 获取
#   export TELEGRAM_API_ID='1234567'                # 可选，my.telegram.org
#   export TELEGRAM_API_HASH='0123456789abcdef'     # 可选
#   export TELEGRAM_ALLOWED_USER_IDS='123456789'    # 可选，允许使用 Bot 的 Telegram user id
#   ./deploy-local.sh
#
# 所有数据落在本目录的 data/ 下，便于整体打包迁移。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==> 1. 生成 .env"
if [ ! -f .env ]; then
    : "${PUBLIC_URL:?请先设置 PUBLIC_URL，例如 https://cloud.example.com}"
    : "${TELEGRAM_BOT_TOKEN:?请先设置 TELEGRAM_BOT_TOKEN}"
    DB_PASSWORD=$(openssl rand -hex 32)
    SESSION_SECRET=$(openssl rand -hex 32)
    STORAGE_CREDENTIALS_SECRET=$(openssl rand -hex 32)
    cat > .env <<ENV
# tg-vault 部署配置（本机生成，已在 .gitignore 中排除，请勿提交）

# 公网地址（单域名时前后端填同一个，由反向代理按路径分流）
VITE_API_URL=${PUBLIC_URL}
CORS_ORIGIN=${PUBLIC_URL}
OAUTH_CALLBACK_BASE_URL=${PUBLIC_URL}
OAUTH_FRONTEND_ORIGIN=${PUBLIC_URL}
COOKIE_SECURE=true
COOKIE_SECURE_FORCE=true
TRUST_PROXY=loopback

# 自动生成的密钥
DB_PASSWORD=${DB_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
STORAGE_CREDENTIALS_SECRET=${STORAGE_CREDENTIALS_SECRET}

# Telegram
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_API_ID=${TELEGRAM_API_ID:-}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH:-}
TELEGRAM_ALLOWED_USER_IDS=${TELEGRAM_ALLOWED_USER_IDS:-}
TELEGRAM_REQUIRED=false

# 纯文本消息归档（本仓库新增功能）
TELEGRAM_TEXT_ARCHIVE=true
TELEGRAM_TEXT_ARCHIVE_REPLY=true
ENV
    chmod 600 .env
    echo "    已生成 .env"
else
    echo "    .env 已存在，保留"
fi

echo "==> 2. 准备数据目录（全部落在 $DIR/data 下）"
mkdir -p data/app data/postgres
# 后端容器内以 node(1000) 运行；postgres 镜像内为 postgres(70)
chown -R 1000:1000 data/app 2>/dev/null || true
chown -R 70:70 data/postgres 2>/dev/null || true

echo "==> 3. 构建并启动（首次构建较慢，需拉取 npm 依赖）"
docker compose up -d --build 2>&1 | tail -12

echo
echo "==> 4. 容器状态"
docker compose ps
