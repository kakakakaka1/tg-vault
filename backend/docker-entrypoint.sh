#!/bin/sh
# 后端容器入口：以 root 起步修正 /data 挂载目录属主，再降权到 node(1000) 运行。
#
# 为什么需要：镜像里虽有 chown node:node /data，但 bind mount 会覆盖它。
# 换机器时目录被拷贝，属主会变成拷贝者，后端就会因 EACCES 无法读写上传目录、
# 密钥目录，表现为启动失败或上传报错。
# 放在入口脚本里做，就不必额外起一个 init 容器。
set -e

APP_UID=1000
APP_GID=1000

mkdir -p /data/uploads /data/thumbnails /data/previews /data/chunks /data/secrets /data/logs
chown -R "$APP_UID:$APP_GID" /data 2>/dev/null || true

exec su-exec "$APP_UID:$APP_GID" node dist/index.js
