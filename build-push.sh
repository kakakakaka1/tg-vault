#!/bin/bash
# 重建 tg-vault 镜像（打上私有仓库标签）、启动、验证、推送
set -euo pipefail

DIR="${PROJECT_DIR:-/opt/tg-vault}"
REG="${REGISTRY_HOST:-image.rar.li}"
cd "$DIR"

echo "==> 1. 重新构建镜像"
docker compose build 2>&1 | tail -8

echo
echo "==> 2. 重建容器"
docker compose up -d 2>&1 | tail -8
sleep 15

echo
echo "==> 3. 容器状态"
docker compose ps

echo
echo "--- 后端主进程真实运行用户（应为 1000） ---"
docker top tg-vault-backend -o pid,user,args 2>/dev/null | head -3

echo
echo "==> 4. 健康检查"
echo -n "    /health: "; curl -s -m 10 http://127.0.0.1:51947/health || true; echo
echo -n "    前端:    "; curl -s -m 10 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:47832/ || true

echo
echo "==> 5. 推送镜像到 $REG"
docker login "$REG" -u "${REGISTRY_USER:-admin}" -p "${REGISTRY_PASSWORD:?请先设置 REGISTRY_PASSWORD}" >/dev/null 2>&1 && echo "    登录成功"
docker push "$REG/library/tg-vault-backend:latest" 2>&1 | tail -2
docker push "$REG/library/tg-vault-frontend:latest" 2>&1 | tail -2

echo
echo "==> 6. 本地镜像"
docker images --digests | grep -E "REPOSITORY|tg-vault"
