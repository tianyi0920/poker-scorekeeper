# 极空间 NAS：从 Docker Hub 部署固定版本

## 先回答三个容易混淆的问题

- 源码仓库是私有的：`github.com/tianyi0920/poker-scorekeeper`。极空间不需要登录 GitHub，也不需要完整源码树。
- 镜像仓库是公开的：`docker.io/tianyi920/poker-scorekeeper`；首次发布版本为 `docker.io/tianyi920/poker-scorekeeper:1.0.0`。NAS 只拉取已经发布的固定版本镜像。
- NAS 项目目录只需要仓库根目录的 `docker-compose.registry.yml` 和 `.env.extremespace.example`，再加上本机生成的 `.env.production` 与 `data` 持久目录。

不要在 NAS 上执行源码构建，也不要把私有仓库的完整工作树复制到 NAS。请从可信的发布包或管理电脑取得上述两个不含秘密的模板文件；真实 `.env.production` 只保留在 NAS，绝不提交、截图或发送到聊天中。

## 1. 建立 NAS 项目目录

在极空间的终端中选择一个由你管理的数据目录，并用同一路径保存 Compose、环境文件和持久数据：

先将 `/path/selected-in-extremespace/poker-scorekeeper` 替换为你在极空间实际选择的目录，再执行下面的命令：

```sh
export POKER_DIR=/path/selected-in-extremespace/poker-scorekeeper
mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
cd "$POKER_DIR"
sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
```

运行镜像最终以 UID/GID `1000:1000` 的 `node` 用户运行；三个 bind 目录都必须可由该用户写入。上面的所有者和 `750` 权限适用于普通 Linux 文件系统；若极空间共享目录的 ACL 覆盖传统权限，请在管理界面授予同一 UID/GID 对三个目录的读、写和进入权限，再重新检查权限。不要把三个目录设为所有人可写。

将 `docker-compose.registry.yml` 和 `.env.extremespace.example` 放在当前目录。确认 Compose 文件只引用 `docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION}`，没有 `build:`，也没有数据库服务或 `3306` 端口。

## 2. 创建并保护生产环境文件

复制模板并限制为仅当前所有者可读写：

```sh
cp .env.extremespace.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`。首次部署保留固定版本，而不是使用可变标签：

```dotenv
POKER_IMAGE_VERSION=1.0.0
```

把模板中的所有 `CHANGE_ME` 值替换为新的实际值；数据库继续使用现有的 `192.168.10.248:3306/poker_scorekeeper`，并确认 `PUBLIC_ORIGIN` 是公网的完整 HTTPS 地址。`SESSION_SECRET` 与 `CSRF_SECRET` 必须各自独立且随机。密码若含 `@`、`:`、`/` 等字符，填入 `DATABASE_URL` 前必须进行 URL 编码。

`.env.production` 中包含数据库、会话、CSRF、管理员和备份账户凭据：不要把它传给 GitHub、Docker Hub、日志、命令参数或 NAS 截图。

## 3. 首次拉取、启动与检查

先检查展开后的配置；确认端口只绑定到 NAS 本机的 `127.0.0.1:3000`：

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml config --quiet
docker compose --env-file .env.production -f docker-compose.registry.yml pull
docker compose --env-file .env.production -f docker-compose.registry.yml up -d
docker compose --env-file .env.production -f docker-compose.registry.yml ps
docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=100 app
curl --fail http://127.0.0.1:3000/api/health/live
curl --fail http://127.0.0.1:3000/api/health/ready
curl --fail http://127.0.0.1:3000/api/health/deployment
```

镜像入口会先确认生产数据库目标，再运行迁移；迁移失败时服务不会启动。`live` 只表示进程存活；`ready` 还会检查数据库；`deployment` 用于记录当前镜像的部署标识。任一步失败时先查看上面的 `logs` 输出，不要通过改成可变标签或删除迁移来绕过问题。

### 3.1 立即创建并验证首次备份

首次健康检查通过后，立刻完整执行下面的备份验证块。它使用备份脚本实际发布的四件套：`mysql-<stamp>.sql.gz`、`avatars-<stamp>.tar.gz`、`manifest-<stamp>.txt` 与最后发布的 `checksums-<stamp>.txt`。不要把先前的 `latest-stamp` 当作本次成功的证据：若本次没有生成新的 stamp，命令会失败。

```sh
set -eu
BACKUP_STAMP_BEFORE="$(cat data/backups/latest-stamp 2>/dev/null || true)"
docker compose --env-file .env.production -f docker-compose.registry.yml exec -T app node scripts/database/production-backup-target.mjs
docker compose --env-file .env.production -f docker-compose.registry.yml exec -T app /app/scripts/backup/backup.sh
STAMP="$(cat data/backups/latest-stamp)"
test -n "$STAMP"
test -z "$BACKUP_STAMP_BEFORE" || test "$STAMP" != "$BACKUP_STAMP_BEFORE"
test -f "data/backups/mysql-$STAMP.sql.gz"
test -f "data/backups/avatars-$STAMP.tar.gz"
test -f "data/backups/manifest-$STAMP.txt"
test -f "data/backups/checksums-$STAMP.txt"
(
  cd data/backups
  sha256sum --check "checksums-$STAMP.txt"
)
```

任何命令失败都表示备份尚未验证完成；保留日志并停止，而不是继续部署或升级。

## 4. HTTPS 和 WebSocket 反向代理

在极空间同机的反向代理中，为你的 `PUBLIC_ORIGIN` 配置：公网 HTTPS 入口、有效 TLS 证书，以及到 `http://127.0.0.1:3000` 的上游。启用 WebSocket 转发，保留 `Upgrade` 与 `Connection` 请求头，并转发真实客户端 IP。

路由器只需要把 HTTPS 的 `443` 转发到 NAS。不要公开容器 `3000` 端口，也不要新增 MariaDB `3306` 的公网转发。部署后用手机通过 HTTPS 测试登录、头像上传和实时牌局更新；若实时连接失败，先核对域名与 `PUBLIC_ORIGIN`、`WS_ALLOWED_ORIGINS` 是否完全一致，再检查 WebSocket 请求头转发。

## 5. 升级操作卡

升级前必须重新完整执行第 3.1 节的备份验证块，并保留新 stamp 和当前固定版本号；只运行备份脚本、读取旧 `latest-stamp` 或只看到一个文件都不算通过。备份或四件套/校验任一步失败即停止升级，不能先拉取或启动新版本再补做备份。

编辑 `.env.production`，把 `POKER_IMAGE_VERSION` 改为要升级的已发布固定版本，例如：

```dotenv
POKER_IMAGE_VERSION=1.0.1
```

然后拉取、重建并再次完成全部健康检查：

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml pull
docker compose --env-file .env.production -f docker-compose.registry.yml up -d
docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=200 app
curl --fail http://127.0.0.1:3000/api/health/live
curl --fail http://127.0.0.1:3000/api/health/ready
curl --fail http://127.0.0.1:3000/api/health/deployment
```

## 6. 回滚操作卡

如果新镜像未通过健康检查或应用验收，先保留日志和备份记录。将 `.env.production` 改回 previous fixed version，例如：

```dotenv
POKER_IMAGE_VERSION=1.0.0 # previous fixed version
```

然后再次拉取并启动该固定版本：

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml pull
docker compose --env-file .env.production -f docker-compose.registry.yml up -d
docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=200 app
curl --fail http://127.0.0.1:3000/api/health/ready
```

数据库迁移是 forward-only；镜像回滚 does not roll back the schema。不要对活动生产库执行自动恢复或手工降级 SQL。若确实需要数据库恢复，只能从备份先恢复到隔离的新数据库，验证后在单独的停机窗口人工切换。

## 日常排障

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml ps
docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=200 app
curl -i http://127.0.0.1:3000/api/health/live
curl -i http://127.0.0.1:3000/api/health/ready
curl -i http://127.0.0.1:3000/api/health/deployment
```

日志虽然会脱敏，仍应限制可查看日志的 NAS 账户。请求支持时不要粘贴 Cookie、Authorization、数据库 URL、令牌、密码或完整 `.env.production`。
