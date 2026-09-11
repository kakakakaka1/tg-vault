# 本地改动记录（非上游代码）

本项目基于 [hicocos/tg-vault](https://github.com/hicocos/tg-vault)，
在服务器上做了以下本地改动。**`git pull` 或运行上游 `./deploy/install.sh` 前请先看这里**，
否则改动可能被覆盖。

---

## 1. 新增功能：Telegram 纯文本消息归档

### 背景

上游只把**带媒体的消息**交给 `handleFileUpload` 入库；纯文本消息（非命令）
在 `telegramBot.ts` 里只回一句提示、不落库。也就是说：
发给 Bot 的文字**不会被保存**，图片和文件才会。

### 改动内容

**新增文件** `backend/src/services/telegramTextArchive.ts`

导出三个东西：

| 导出 | 作用 |
|---|---|
| `archiveTextMessage(client, event)` | 把一条文本消息写成 `.txt` 存入当前激活的存储目标，并登记到 `files` 表 |
| `isTextArchiveEnabled()` | 读环境变量 `TELEGRAM_TEXT_ARCHIVE`（默认开启） |
| `isTextArchiveReplyEnabled()` | 读环境变量 `TELEGRAM_TEXT_ARCHIVE_REPLY`（默认开启） |

复用了与 Web 上传完全相同的入库链路，保证行为一致：

```
storageManager.getActiveTarget()          → 当前存储目标（provider + accountId）
getStoragePathRules() + buildStorageFolderWithRules()  → 与媒体一致的归档目录
getUniqueStoredName()                     → 不重名的物理文件名
saveAndIndexWithCompensation()            → provider.saveFile() + INSERT INTO files
```

归档文件内容为「元信息头 + 正文」：

```
Telegram 文本归档
=================
时间     : 2026-09-11 14:05:33
会话     : 我的收藏
会话 ID  : <你的 Telegram user id>
发送者 ID: <你的 Telegram user id>
消息 ID  : 12345

-------- 正文 --------

<原始文本>
```

文件命名：`YYYYMMDD-HHmmss_<正文首行前60字>.txt`，因此**在 Web 控制台里能按内容搜索到**。
`files.type` 记为 `document`（`text/plain` 由 `getFileType()` 判定），可预览、下载、删除。

**修改文件** `backend/src/services/telegramBot.ts`

在文件/文本处理段插入文本归档分支（约 2140 行）：

```ts
// File Handling
if (message.media) {
    await handleFileUpload(client, event);
}

// 纯文本消息归档：非命令、无媒体、且没有待处理的交互状态
if (!message.media && text && !text.startsWith('/')) {
    if (!(await isAuthenticatedAsync(senderId))) {
        await message.reply({ message: MSG.UNKNOWN_TEXT });
    } else if (isTextArchiveEnabled() && !userStates.get(senderId)) {
        const archived = await archiveTextMessage(client, event);
        ...
    }
}
```

### 三个刻意的边界条件

1. **`!text.startsWith('/')`** —— 命令不归档，避免把 `/list` 之类写进归档
2. **`!message.media`** —— 带媒体的消息由原逻辑处理，其 caption 不重复归档
3. **`!userStates.get(senderId)`** —— 该用户有待处理的交互状态时跳过，
   **防止把 2FA 验证码写进归档文件**

### 开关

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TELEGRAM_TEXT_ARCHIVE` | `true` | 设为 `false`/`0`/`off` 关闭文本归档 |
| `TELEGRAM_TEXT_ARCHIVE_REPLY` | `true` | 是否回复「📝 已归档文本：xxx.txt」确认 |

---

## 2. docker-compose.yml：命名卷 → bind mount

上游用 Docker 命名卷（`file-storage`、`postgres-data`），数据不在项目目录下，
迁移时容易漏。已改为项目内目录，**所有数据落在 `/opt/tg-vault/data/`**：

| 原 | 现 | 说明 |
|---|---|---|
| `file-storage:/data` | `./data/app:/data` | 上传文件、缩略图、预览、分片、密钥 |
| `postgres-data:/var/lib/postgresql/data` | `./data/postgres:/var/lib/postgresql/data` | 数据库 |

顶层 `volumes:` 块已删除。后端在 `environment` 中显式声明了
`TELEGRAM_TEXT_ARCHIVE` / `TELEGRAM_TEXT_ARCHIVE_REPLY`。

### 目录属主（迁移必看）

| 目录 | 需要属主 | 原因 |
|---|---|---|
| `data/app` | `1000:1000` | 后端容器以 `node`(uid 1000) 运行 |
| `data/postgres` | `70:70` | postgres 镜像内 `postgres` 用户 uid 70 |

**属主不对的后果**：后端崩溃或无法上传（`EACCES`）；postgres 拒绝启动。
官方 postgres 镜像在数据目录为空时会自行 chown，所以主要要留意 `data/app`。

修复命令：

```bash
chown -R 1000:1000 /opt/tg-vault/data/app
chown -R 70:70 /opt/tg-vault/data/postgres
```

打包迁移时用 root 执行 `tar` 可保留属主：

```bash
tar czf tg-vault.tar.gz -C /opt tg-vault
```

---

## 3. 部署方式

上游的 `./deploy/install.sh` 是**交互式**向导（会提示输入两个公网地址）。
本机改用脚本化的 `deploy-local.sh` 直接生成 `.env` 并 `docker compose up -d --build`，
两个文件的地址都指向同一个域名 `https://tg.rar.li`（Caddy 按路径分流前后端）。

**注意**：`VITE_API_URL` 会被**打包进前端静态文件**，改它必须重新构建前端镜像
（`docker compose build frontend`），仅重启容器无效。

---

## 4. Caddy 反代（单域名分流）

`/etc/caddy/Caddyfile` 中 `tg.rar.li` 的配置：

```
tg.rar.li {
	handle /api/*        { reverse_proxy 127.0.0.1:51947 }
	handle /uploads/*    { reverse_proxy 127.0.0.1:51947 }
	handle /thumbnails/* { reverse_proxy 127.0.0.1:51947 }
	handle /livez        { reverse_proxy 127.0.0.1:51947 }
	handle /readyz       { reverse_proxy 127.0.0.1:51947 }
	handle /health       { reverse_proxy 127.0.0.1:51947 }
	handle               { reverse_proxy 127.0.0.1:47832 }
}
```

后端所有接口都在 `/api`、`/uploads`、`/thumbnails` 前缀下（见 `backend/src/index.ts` 的
`app.use` 挂载），其余请求交给前端静态站点。两个端口都只绑 `127.0.0.1`，不直接对公网开放。

---

## 5. 首次使用步骤

1. 浏览器打开 `https://tg.rar.li`，按提示创建**网页管理员密码**（至少 8 位）
2. 进入 **设置 → Telegram**：
   - Bot Token 与 API ID/Hash 已通过 `.env` 预填，点「测试连接」确认
   - 设置 **Bot PIN**（4 位数字），用于在 Telegram 里认证
   - 「Telegram Bot 用户权限」填 `<你的 Telegram user id>`
3. 在 Telegram 私聊 Bot，发送 `/start` 并输入 PIN 完成认证
4. 之后发给 Bot 的**文字、图片、文件都会被归档**，在 Web 控制台的「文件」里可查看

> Bot 只处理私聊消息。归档目录默认按「来源 / 会话 / 类型」自动分层。

---

## 6. 可迁移部署改造：镜像推私有仓库 + 入口脚本修属主

目标：**拷 `/opt/tg-vault` 到新机器 → `docker compose up -d` → 与现在完全一致**。

### 6.1 自建镜像改为私有仓库地址

`docker-compose.yml` 里两个自建镜像：

| 原 | 现 |
|---|---|
| `tg-vault-frontend:${IMAGE_VERSION:-source}` | `image.rar.li/library/tg-vault-frontend:${IMAGE_VERSION:-latest}` |
| `tg-vault-backend:${IMAGE_VERSION:-source}` | `image.rar.li/library/tg-vault-backend:${IMAGE_VERSION:-latest}` |

compose 里 `image:` 与 `build:` 并存：新机器上镜像不存在时 `docker compose up -d`
**会自动从仓库拉取**（实测：删光本地镜像后 `up -d` 直接拉取并启动，未触发构建）；
需要改代码时 `docker compose build && docker push` 即可。

已推送：

```
image.rar.li/library/tg-vault-backend:latest    sha256:652cfd828713e61ac434d617d60867e884f14dfb8ab9b559a506d3ecaff4988e
image.rar.li/library/tg-vault-frontend:latest   sha256:1268a6c31baad6f59ea92a5d25529a2c3bf380e59864fe6f5d198f4850170de5
```

`postgres` 仍用 Docker Hub 官方镜像（按 digest 固定版本），新机器需能访问 Docker Hub。

### 6.2 后端入口脚本修属主（`backend/docker-entrypoint.sh`）

容器内后端以 uid **1000**（`node`）运行，而 bind mount 会覆盖镜像里的 `chown`。
拷目录到新机器后属主变成拷贝者，后端会因 `EACCES` 读写失败。

改动：

1. `backend/Dockerfile` —— `apk add` 增加 **`su-exec`**；**删掉 `USER node`**；
   `COPY docker-entrypoint.sh` 并 `chmod +x`；`CMD` 改为 `ENTRYPOINT ["/docker-entrypoint.sh"]`
2. 新增 `backend/docker-entrypoint.sh` —— 以 root 起步，`mkdir -p` 各数据子目录 →
   `chown -R 1000:1000 /data` → `exec su-exec 1000:1000 node dist/index.js`

这样就不必额外起一个 init 容器（跑完会留 Exited 容器，看着像垃圾）。
**实测**：把 `data/app` 属主改成 `root:root` 后 `docker compose up -d`，
属主自动恢复 `1000:1000`，服务正常；`docker top` 确认主进程 USER=**1000**（非 root 保住）。

postgres 侧无需处理：官方镜像入口脚本在数据目录为空时会自行 chown 成 `70:70`。

### 6.3 演练结论

`docker compose down` → 删光两个自建镜像 → 破坏属主 → `docker compose up -d`：

- 镜像从仓库拉取，digest 与推送一致
- 属主自愈为 `1000:1000`
- 三个容器全部 healthy，`/health` 正常

完整迁移步骤见同目录 `MIGRATION.md`。
