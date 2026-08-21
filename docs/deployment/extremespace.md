# 极空间 NAS：从 Docker Hub 部署固定版本

## 先回答三个容易混淆的问题

- 源码仓库是私有的：`github.com/tianyi0920/poker-scorekeeper`。极空间不需要登录 GitHub，也不需要完整源码树。
- 镜像仓库是公开的：`docker.io/tianyi920/poker-scorekeeper`；当前推荐固定版本为 `docker.io/tianyi920/poker-scorekeeper:1.0.5`。NAS 只拉取已经发布的固定版本镜像。
- NAS 项目目录只需要仓库根目录的 `docker-compose.registry.yml` 和 `.env.extremespace.example`，再加上本机生成的 `.env.production` 与 `data` 持久目录。

不要在 NAS 上执行源码构建，也不要把私有仓库的完整工作树复制到 NAS。请从可信的发布包或管理电脑取得上述两个不含秘密的模板文件；真实 `.env.production` 只保留在 NAS，绝不提交、截图或发送到聊天中。

### 极空间“单独创建容器”向导

从 `1.0.2` 开始，生产环境变量会自动列出；当前请选择 `docker.io/tianyi920/poker-scorekeeper:1.0.5`。保留镜像自带的运行时默认值，只修改 `CHANGE_ME` 占位符、`PUBLIC_ORIGIN`、数据库账号和首次管理员信息。镜像不包含任何真实密码或随机密钥，未替换占位符时生产入口会失败关闭。`1.0.4` 起在 Buildx 构建时把全部运行文件实际写入同一个最终镜像层，以兼容会遗漏后段小层的 NAS 容器运行时；`1.0.5` 修复了直连 HTTP 时前端资源被错误强制升级为 HTTPS 而导致白屏的问题。

`/data/avatars`、`/data/backups`、`/data/restore` 三个数据卷会自动列出。必须分别为它们选择极空间上的持久文件夹并保持读写，不能直接接受 Docker 自动创建的匿名卷；匿名卷的位置和生命周期不便于备份、迁移与恢复。镜像内路径已经固定，不要改装载路径，只选择对应的宿主机文件夹。

单独创建模式仍需把容器端口 `3000/TCP` 映射到 NAS 的 `127.0.0.1:3000`，并保持镜像默认入口和命令为空。但是此时先不要启用开机自动启动，也不要点击“应用”：点击“应用”前，必须先完成第 3.1 节，并按其要求先完成第 1、2 节。第 3.1 节的三个一次性 Compose 任务只做生产目标核对、头像核对和备份，显式绕过普通入口，不会迁移数据库，也不会留下第二个长期运行的应用容器。

首次备份验证通过后只选择一种正式启动方式：要么回到极空间向导，确认仍是同一固定镜像、同一组环境变量和三个宿主机目录，然后启用开机自动启动并点击“应用”；要么使用第 3 节的 Compose `up -d`。选择图形界面后不要再执行 Compose 的 `up -d`，选择 Compose 后也不要再创建图形界面应用容器，否则会形成两个实例并发生端口或数据库并发冲突。若图形界面无法限制监听地址、设置只读根文件系统、`/tmp` 临时目录、`no-new-privileges` 和删除全部 capabilities，请只使用下面的 Compose 方式。

## 1. 建立 NAS 项目目录

在极空间的终端中选择一个由你管理的数据目录，并用同一路径保存 Compose、环境文件和持久数据：

先将 `/path/selected-in-extremespace/poker-scorekeeper` 替换为你在极空间实际选择的目录，再执行下面的命令：

```sh
export POKER_DIR=/path/selected-in-extremespace/poker-scorekeeper
export EXISTING_AVATAR_DIR=/path/to/current-avatar-store-or-REUSE-or-NONE
mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
case "$EXISTING_AVATAR_DIR" in
  REUSE)
    sudo test -d "$POKER_DIR/data/avatars"
    ;;
  NONE)
    ;;
  *)
    sudo test -d "$EXISTING_AVATAR_DIR"
    sudo cp -a "$EXISTING_AVATAR_DIR"/. "$POKER_DIR/data/avatars"/
    sudo diff -qr "$EXISTING_AVATAR_DIR" "$POKER_DIR/data/avatars"
    ;;
esac
cd "$POKER_DIR"
sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
sudo chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
```

若这是已有部署的升级或迁移，必须先保留原头像目录：原目录已经是 `"$POKER_DIR/data/avatars"` 时选择 `REUSE`，否则把 `EXISTING_AVATAR_DIR` 改为原头像目录的绝对路径并完成上面的复制和差异检查。只有全新数据库确定从未有上传头像时才选择 `NONE`；这个选择不是人工放行，首次备份前的只读数据库核对仍会在发现任何 `UPLOAD` 引用但缺少对应文件时失败。

运行镜像最终以 UID/GID `1000:1000` 的 `node` 用户运行；三个 bind 目录都必须可由该用户写入。上述命令将目录交给容器用户，因此普通 NAS 操作员以后读取备份文件需要 `sudo`；Docker 命令仍由已获 Docker 权限的普通操作员执行。上面的所有者和 `750` 权限适用于普通 Linux 文件系统；若极空间共享目录的 ACL 覆盖传统权限，请在管理界面为 UID/GID `1000:1000` 在 `"$POKER_DIR"/data/avatars`、`"$POKER_DIR"/data/backups`、`"$POKER_DIR"/data/restore` 授予读、写和进入权限，并在管理界面复核三项权限已生效。不要把三个目录设为所有人可写。

将 `docker-compose.registry.yml` 和 `.env.extremespace.example` 放在当前目录。确认 Compose 文件只引用 `docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION}`，没有 `build:`，也没有数据库服务或 `3306` 端口。

## 2. 创建并保护生产环境文件

复制模板并限制为仅当前所有者可读写：

```sh
cp .env.extremespace.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`。首次部署保留固定版本，而不是使用可变标签：

```dotenv
POKER_IMAGE_VERSION=1.0.5
```

把模板中的所有 `CHANGE_ME` 值替换为新的实际值；数据库继续使用现有的 `192.168.10.248:3306/poker_scorekeeper`，并确认 `PUBLIC_ORIGIN` 是公网的完整 HTTPS 地址。`SESSION_SECRET` 与 `CSRF_SECRET` 必须各自独立且随机。密码若含 `@`、`:`、`/` 等字符，填入 `DATABASE_URL` 前必须进行 URL 编码。

`.env.production` 中包含数据库、会话、CSRF、管理员和备份账户凭据：不要把它传给 GitHub、Docker Hub、日志、命令参数或 NAS 截图。

## 3. 首次拉取、备份、启动与检查

先检查展开后的配置，确认端口只绑定到 NAS 本机的 `127.0.0.1:3000`，再拉取固定版本镜像。此时不要执行 `up`、`start`、`restart` 或普通 `run`：这些操作会进入默认入口并可能先运行数据库迁移。

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml config --quiet
docker compose --env-file .env.production -f docker-compose.registry.yml pull
```

### 3.1 立即创建并验证首次备份

在第一次启动应用、执行入口脚本或迁移之前，完整执行下面的备份验证块。三个一次性容器都复用 registry Compose 中 `app` 服务的生产环境变量、外部 MariaDB 连接与持久目录挂载，但用显式 `--entrypoint` 绕过默认入口；因此生产库目标守卫、头像连续性核对和备份会运行，普通入口与迁移不会提前运行。`--no-deps` 也不会创建测试数据库。

头像核对脚本先验证连接仍是固定生产库，再以只读查询收集当前用户和历史牌局快照中的全部 `UPLOAD` 引用；每个引用都必须是挂载的 `/data/avatars` 下安全的直接子文件，不能缺失、越界或是符号链接。空头像目录只有在数据库没有任何上传引用时才会通过。备份脚本随后把已核对的头像目录一起纳入备份，并发布四件套：`mysql-<stamp>.sql.gz`、`avatars-<stamp>.tar.gz`、`manifest-<stamp>.txt` 与最后发布的 `checksums-<stamp>.txt`。不要把先前的 `latest-stamp` 当作本次成功的证据：若本次没有生成新的 stamp，命令会失败。

```sh
set -eu
: "${POKER_DIR:?Repeat section 1 in this shell first}"
BACKUP_STAMP_BEFORE="$(sudo cat "$POKER_DIR/data/backups/latest-stamp" 2>/dev/null || true)"
docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/production-backup-target.mjs
docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs
docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app
STAMP="$(sudo cat "$POKER_DIR/data/backups/latest-stamp")"
test -n "$STAMP"
test -z "$BACKUP_STAMP_BEFORE" || test "$STAMP" != "$BACKUP_STAMP_BEFORE"
sudo test -f "$POKER_DIR/data/backups/mysql-$STAMP.sql.gz"
sudo test -f "$POKER_DIR/data/backups/avatars-$STAMP.tar.gz"
sudo test -f "$POKER_DIR/data/backups/manifest-$STAMP.txt"
sudo test -f "$POKER_DIR/data/backups/checksums-$STAMP.txt"
sudo sh -c 'cd "$1" && sha256sum --check "$2"' sh "$POKER_DIR/data/backups" "checksums-$STAMP.txt"
```

任何命令失败都表示备份尚未验证完成；保留日志并停止，而不是继续部署或升级。只有新 stamp、四个对应文件及校验和全部通过后，才可首次启动。若选择 Compose，执行：

```sh
docker compose --env-file .env.production -f docker-compose.registry.yml up -d
docker compose --env-file .env.production -f docker-compose.registry.yml ps
docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=100 app
curl --fail http://127.0.0.1:3000/api/health/live
curl --fail http://127.0.0.1:3000/api/health/ready
curl --fail http://127.0.0.1:3000/api/health/deployment
```

这次 `up` 才会进入镜像的普通入口：入口先再次确认生产数据库目标，再运行迁移；迁移失败时服务不会启动。`live` 只表示进程存活；`ready` 还会检查数据库；`deployment` 用于记录当前镜像的部署标识。任一步失败时先查看上面的 `logs` 输出，不要通过改成可变标签或删除迁移来绕过问题。

若选择极空间“单独创建容器”，不要执行上面的 `up -d`；回到向导按开头的单独创建说明启动唯一的正式容器，并在极空间日志页和浏览器中完成同样的三个健康检查。

## 4. HTTPS 和 WebSocket 反向代理

在极空间同机的反向代理中，为你的 `PUBLIC_ORIGIN` 配置：公网 HTTPS 入口、有效 TLS 证书，以及到 `http://127.0.0.1:3000` 的上游。启用 WebSocket 转发，保留 `Upgrade` 与 `Connection` 请求头，并转发真实客户端 IP。

路由器只需要把 HTTPS 的 `443` 转发到 NAS。不要公开容器 `3000` 端口，也不要新增 MariaDB `3306` 的公网转发。部署后用手机通过 HTTPS 测试登录、头像上传和实时牌局更新；若实时连接失败，先核对域名与 `PUBLIC_ORIGIN`、`WS_ALLOWED_ORIGINS` 是否完全一致，再检查 WebSocket 请求头转发。

## 5. 升级操作卡

升级前必须重新完整执行第 3.1 节的备份验证块，并保留新 stamp 和当前固定版本号；只运行备份脚本、读取旧 `latest-stamp` 或只看到一个文件都不算通过。备份或四件套/校验任一步失败即停止升级，不能先拉取或启动新版本再补做备份。

升级单独创建的容器时，先用当前固定版本完成上述备份验证，再停止并删除旧应用容器，但绝不能删除三个宿主机持久目录；随后在向导中选择新的固定版本，并复用原环境值和原三个宿主机目录。该路径仍然不要执行 Compose 的 `up -d`。以下拉取与 `up -d` 命令只适用于原本就选择 Compose 的部署。

编辑 `.env.production`，把 `POKER_IMAGE_VERSION` 改为要升级的已发布固定版本，例如：

```dotenv
POKER_IMAGE_VERSION=1.0.5
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
POKER_IMAGE_VERSION=1.0.2 # previous fixed version
```

回滚单独创建的容器时，先停止并删除失败的应用容器，但保留原环境值和三个宿主机持久目录；在向导中选择 `1.0.2` 固定版本，重新挂载同一组目录并保持默认入口和命令为空，再启动唯一的正式容器。该路径不要执行 Compose 的 `up -d`，并在启动后重新检查日志及三个健康地址。

若原本选择 Compose，则再次拉取并启动该固定版本：

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
