# Build stage
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# esbuild 极快且内存占用低，不再需要调高 Node 内存限制

COPY package*.json ./
RUN npm ci

# 复制源代码并构建
COPY . .
RUN npm run build \
    && npx esbuild src/scripts/login_telegram_user.ts --bundle --platform=node --format=esm --outfile=dist/scripts/login_telegram_user.js --packages=external


# Production stage
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ARG SOURCE_REVISION=unknown
ARG SOURCE_VERSION=worktree
ARG SOURCE_URL=https://github.com/hicocos/tg-vault
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$SOURCE_VERSION \
      org.opencontainers.image.source=$SOURCE_URL

WORKDIR /app

# 安装 sharp 需要的依赖 和 ffmpeg (用于视频处理)
# su-exec：入口脚本降权到 node 用户（官方 postgres/redis 镜像同款）
RUN apk add --no-cache vips-dev ffmpeg ca-certificates curl su-exec

# 复制依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制构建产物
COPY --from=builder /app/dist ./dist
# 复制数据库方案文件 (esbuild 模式下与 index.js 同级)
COPY --from=builder /app/src/db/schema.sql ./dist/schema.sql
COPY --from=builder /app/src/db/migrations ./dist/migrations

# 创建数据目录
RUN mkdir -p /data/uploads /data/thumbnails /data/previews

# 设置权限
RUN chown -R node:node /app /data

# 入口脚本以 root 起步修正 bind mount 属主，再用 su-exec 降权到 node
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 51947

ENTRYPOINT ["/docker-entrypoint.sh"]
