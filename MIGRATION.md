# 迁移说明

整个 `/opt/tg-vault` 目录是**自包含**的：拷到新机器 → `docker compose up -d` → 与现在完全一致。

## 一、打包（旧机器）

```bash
cd /opt
tar czf tg-vault.tar.gz tg-vault
```

用 **root** 执行，可保留文件属主（虽然后端入口脚本会自动修正，但保留更省事）。

## 二、部署（新机器）

```bash
mkdir -p /opt && tar xzf tg-vault.tar.gz -C /opt && cd /opt/tg-vault
docker compose up -d          # 镜像自动从 image.rar.li 拉取，不需要本地构建
docker compose ps
curl -s http://127.0.0.1:51947/health
```

新机器需要：Docker + Docker Compose、能访问 `image.rar.li` 与 Docker Hub
（后者用于拉 `postgres` 基础镜像）。私有仓库需要认证时先登录一次：

```bash
docker login image.rar.li -u admin -p '<密码>'
```

## 三、必须带走的文件

| 路径 | 说明 |
|---|---|
| `docker-compose.yml` | 编排（前端 + 后端 + 数据库），本地维护版 |
| `.env` | 全部配置：域名、数据库密码、会话密钥、Telegram 凭证 |
| `data/app/` | **上传的文件、缩略图、预览、分片、密钥（secrets）** |
| `data/postgres/` | **数据库全部数据** |
| `backend/src/`、`frontend/` | 源码，仅在需要重新构建时用到 |
| `LOCAL-NOTES.md` | 本地改动记录（含新增的文本归档功能说明） |
| `deploy-local.sh` | 本机用的非交互部署脚本 |

> `data/app/secrets/` 里是加密第三方存储凭证与会话签名的密钥材料，
> **丢失后登录会话、TOTP 密钥、已保存的存储凭证都需要重新配置**，务必一起带走。

## 四、三个服务

| 服务 | 作用 | 端口 |
|---|---|---|
| `frontend` | React 静态站点（nginx） | `127.0.0.1:47832` |
| `backend` | API 与 Telegram 服务 | `127.0.0.1:51947` |
| `postgres` | 数据库（官方镜像，按 digest 固定版本） | 仅容器网络内 |

镜像来源：

- `image.rar.li/library/tg-vault-backend:latest`（自建，已推私有仓库）
- `image.rar.li/library/tg-vault-frontend:latest`（自建，已推私有仓库）
- `postgres@sha256:cf78e766...`（Docker Hub 官方镜像，按 digest 固定）

## 五、文件属主（不用你操心，但要知道）

后端容器内以 uid **1000**（`node`）运行，而 bind mount 会覆盖镜像里的 `chown`。
把目录拷到新机器后属主会变成拷贝者，后端就会因 `EACCES` 读写失败。

`backend/docker-entrypoint.sh` 在**每次启动时**以 root 起步，先把 `/data` 递归 chown 成
`1000:1000`，再用 `su-exec` 降权运行 —— 所以这一步是自动的。

postgres 侧无需处理：官方镜像的入口脚本在数据目录为空时会自行 chown 成 `70:70`。

如果遇到权限类报错，手动执行：

```bash
chown -R 1000:1000 /opt/tg-vault/data/app
chown -R 70:70    /opt/tg-vault/data/postgres
```

## 六、常用命令

```bash
docker compose ps                    # 状态
docker compose logs -f backend       # 后端日志（含 Bot 连接情况）
docker compose logs -f frontend
docker compose restart backend
docker compose down                  # 停止（数据保留在 data/ 目录）

# 改了源码后重新构建并推送
docker compose build
docker push image.rar.li/library/tg-vault-backend:latest
docker push image.rar.li/library/tg-vault-frontend:latest
```

## 七、常见故障

**后端一直 Restarting，日志报 `EACCES` / `permission denied`**
属主不对且入口脚本没生效。确认 `backend/docker-entrypoint.sh` 存在、
compose 里后端服务的 `entrypoint` 没被覆盖。

**前端能打开但接口全失败**
`VITE_API_URL` 是**打包进前端静态文件**的，改它必须重建前端镜像
（`docker compose build frontend`），仅重启容器无效。

**上传大文件失败**
检查磁盘剩余空间，以及 `TG_MIN_FREE_DISK_GB`（默认 8G）与 `CHUNK_DISK_RESERVE_GB`（默认 8G）
—— 磁盘水位不足时后端会主动拒绝写入。

**Bot 没反应**
在 Web 的「设置 → Telegram」确认 Bot 状态；日志里应有
`Signed in successfully as ...` 与 `Telegram Bot 启动成功`。

**Caddy 反代不在本目录内**
域名与反代规则需在新机器另行配置，配置样例见 `LOCAL-NOTES.md` 第 4 节。
