# 群晖 NAS 生产部署与恢复手册

本手册部署一个同源容器：手机浏览器访问的 PWA、`/api`、Socket.IO 与头像文件都由同一进程提供。MySQL 不在 Compose 中发布端口；群晖反向代理只连接 NAS 回环地址 `127.0.0.1:3000`。

> 本项目曾通过对话传递过数据库凭据。旧密码已经暴露，禁止用它连接、建库或作为回退。上线前必须先在 MariaDB 中轮换并使旧值失效，只把新值写入 NAS 上权限为 `600` 的 `.env.production`。不要把该文件提交、复制到镜像、终端输出或截图。

当前仓库的生产部署尚未执行。未取得已轮换凭据、bootstrap 管理员、`SESSION_SECRET`、`CSRF_SECRET`、`PUBLIC_ORIGIN` 和明确的群晖操作方式前，停在 [生产上线检查表](./production-checklist.md) 的第 0 节。

## 1. NAS 和数据库准备

1. 确认 NAS 架构：`uname -m`。普通 `docker compose build` 会为当前 NAS 架构构建，无需发布多架构镜像。
2. 安装 Container Manager，并在共享文件夹建立项目目录，例如 `/volume1/docker/poker-scorekeeper`。
3. 将仓库复制到该目录，然后创建持久目录：

   ```sh
   cd /volume1/docker/poker-scorekeeper
   install -d -m 750 /volume1/docker/poker-scorekeeper/data/avatars
   install -d -m 750 /volume1/docker/poker-scorekeeper/data/backups
   install -d -m 750 /volume1/docker/poker-scorekeeper/data/restore
   sudo chown -R 1000:1000 data/avatars data/backups data/restore
   chmod 750 data/avatars data/backups data/restore
   ```

   镜像以非 root 的 `node` 用户（UID/GID 1000）运行。如果 NAS 的 ACL 覆盖传统权限，请在 File Station 同时授予该 UID 对三个目录的读写权限。Compose 挂载的是恢复父目录 `data/restore`；恢复目标 `data/restore/avatars` 必须是其中的普通子目录，不能把目标本身做 bind mount。

4. 在 MariaDB 中单独创建应用账户与备份账户，并遵循最小权限。生产应用库名为 `poker_scorekeeper`，NAS 内网地址为 `192.168.10.248:3306`。不要给远程应用账户 `DROP DATABASE` 或全局管理权限。
5. 公网测试端点 `tianyi.wiki:8306/poker_scorekeeper_test` 只用于明确授权的测试；生产容器不得指向它。本仓库的容器烟测使用 `docker-compose.test.yml` 内部的临时 MySQL，不访问该远程端点。

## 2. 生产环境文件

复制模板并收紧权限：

```sh
cp .env.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`，至少替换下列占位符：

```dotenv
PORT=3000
PUBLIC_ORIGIN=https://poker.example.com
WS_ALLOWED_ORIGINS=https://poker-lan.example.com
DATABASE_URL=mysql://poker_user:<password>@192.168.10.248:3306/poker_scorekeeper
SESSION_SECRET=CHANGE_ME_TO_AN_INDEPENDENT_32_BYTE_RANDOM_VALUE
CSRF_SECRET=CHANGE_ME_TO_AT_LEAST_32_RANDOM_BYTES
BOOTSTRAP_ADMIN_USERNAME=rootadmin
BOOTSTRAP_ADMIN_NICKNAME=初始管理员
BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_TO_A_UNIQUE_STRONG_PASSWORD
READINESS_TIMEOUT_MS=2000
MYSQL_HOST=192.168.10.248
MYSQL_PORT=3306
MYSQL_USER=poker_backup_user
MYSQL_PASSWORD=<password>
MYSQL_DATABASE=poker_scorekeeper
AVATAR_ROOT=/data/avatars
```

`SESSION_SECRET` 与 `CSRF_SECRET` 必须分别生成，不能复用。密码含 `@`、`:`、`/` 等字符时，`DATABASE_URL` 中的用户名和密码必须做 URL 编码。生产 `PUBLIC_ORIGIN` 必须是没有用户名、密码、路径、查询串或片段的完整 `https://` 源站；`WS_ALLOWED_ORIGINS` 只允许额外的精确来源，多个值用英文逗号分隔，不要使用 `*`。首次启动会创建超级管理员并要求改密；确认已有活跃超级管理员且强制改密成功后，从环境文件移除三个 `BOOTSTRAP_ADMIN_*` 值并重建容器。

## 3. 构建、启动和检查

发布与恢复校验要求 Docker Compose 2.34.0 或更高版本；脚本在任何耗时测试前检查 CLI、daemon、Buildx 和 Compose 版本并失败关闭。该最低版本保证隔离恢复所用的 `docker compose run --env-from-file` 可用。

命令行部署。`production-preflight.mjs` 只执行 `SELECT`、`SHOW GRANTS` 和会话级 `USE`；它固定拒绝除 `192.168.10.248:3306/poker_scorekeeper` 之外的目标。正式 Compose 设置 `PRODUCTION_TARGET_REQUIRED=1`，因此建库、显式迁移和正常启动都会在任何写入前重新运行同一门禁：

```sh
docker compose config --quiet
docker compose build --pull
docker compose run --rm app node scripts/database/production-preflight.mjs
docker compose run --rm app node scripts/database/create-database.mjs
docker compose run --rm app pnpm --filter @poker/api prisma migrate deploy
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
curl --fail http://127.0.0.1:3000/api/health/live
curl --fail http://127.0.0.1:3000/api/health/ready
```

容器入口先执行固定目标只读预检，再执行 `prisma migrate deploy`，成功后才启动服务。显式 `docker compose run` 命令由入口转交执行，不再被入口忽略；除预检本身外，生产一次性命令也先经过固定目标门禁。`live` 只表示进程存活，不访问数据库；`ready` 会在短超时内查询数据库，数据库不可用时返回 HTTP 503 和稳定的 `DATABASE_UNAVAILABLE` 错误体。生产 Compose 只绑定 `127.0.0.1:3000`，不会把 3000 暴露到局域网，也不会发布 3306。

在 Container Manager 图形界面中，可选择“项目 → 新增 → 创建 docker-compose.yml”，项目路径选上述目录，项目名固定为 `poker-scorekeeper`。确认预览中只有 `app` 服务且端口映射是 `127.0.0.1:3000:3000`，再构建并启动。

## 4. HTTPS、WebSocket 与公网入口

在 DSM“登录门户 → 高级 → 反向代理服务器”中新建规则：

- 来源：`HTTPS`、公网域名、端口 `443`，使用有效证书；
- 目的地：`HTTP`、主机 `127.0.0.1`、端口 `3000`；
- 自定义请求头允许 WebSocket：`Upgrade: $http_upgrade`、`Connection: $connection_upgrade`；
- 转发真实客户端 IP 头，并保持应用只信任群晖这一跳代理；
- 启用 HTTP/2，并在确认所有入口均为 HTTPS 后开启 HSTS。建议先用较短 `max-age` 验证，再逐步增加；
- 路由器只转发 TCP 443 到 NAS。不要转发容器端口 3000，也不要为 MySQL 3306 新增公网转发。

应用在生产环境只信任一个反向代理跳数，因此不要再串联未经配置的第二层代理。登录后分别测试普通 API、头像上传、刷新深层 PWA 路由，以及一台手机上的 Socket.IO 实时更新。若 WebSocket 失败，先检查域名是否与 `PUBLIC_ORIGIN`/`WS_ALLOWED_ORIGINS` 精确一致，再检查 DSM 的 Upgrade/Connection 请求头。

自动可逆验收使用未跟踪、权限为 `600` 的 `.env.acceptance` 传递 `PUBLIC_ORIGIN`、bootstrap 用户名/当前密码与 `PRODUCTION_ADMIN_NEW_PASSWORD`；不要把值展开到命令行：

```sh
chmod 600 .env.acceptance
docker compose run --rm --env-from-file .env.acceptance app node scripts/verify-production.mjs
```

脚本只创建一个临时普通用户和一个不含购买的空局，通过公开 HTTPS/WSS 完成登录、CSRF、强制改密、开局和房间加入，然后作废空局并逻辑删除临时用户；失败路径也只清理这两个由本轮返回 ID 标识的对象。它不会购买筹码或提交结算。如果脚本在强制改密后失败，重跑前必须把受保护验收文件中的当前密码更新为刚设置的新值，并再选择一个不同的新密码；禁止回退到已失效的初始值。脚本中的 Node WebSocket 客户端不能替代真实手机验收：仍须用手机通过公网 HTTPS 进入空局并确认观战者实时出现，之后才能记录最终验收时间。完成后安全删除 `.env.acceptance`，并按 [生产上线检查表](./production-checklist.md) 运行首次备份和生成无秘密的 [生产验证记录](./production-verification.md)。

## 5. 本地隔离容器烟测

以下项目名、网络和卷均与生产隔离，数据库没有主机端口。它不会连接 `tianyi.wiki` 或 `192.168.10.248`：

```sh
docker compose -p poker17smoke -f docker-compose.test.yml config --quiet
docker compose -p poker17smoke -f docker-compose.test.yml up -d --build
docker compose -p poker17smoke -f docker-compose.test.yml ps
curl --fail http://127.0.0.1:3000/api/health/ready
docker compose -p poker17smoke -f docker-compose.test.yml exec -T app sh -c 'touch /data/avatars/persist-smoke && test -f /data/avatars/persist-smoke'
docker compose -p poker17smoke -f docker-compose.test.yml restart app
docker compose -p poker17smoke -f docker-compose.test.yml exec -T app test -f /data/avatars/persist-smoke
```

清理前先核对项目标签，只删除这个烟测项目的资源：

```sh
docker compose -p poker17smoke -f docker-compose.test.yml ps -a
docker volume ls --filter label=com.docker.compose.project=poker17smoke
docker compose -p poker17smoke -f docker-compose.test.yml down -v --remove-orphans
```

合并或发布前在开发机运行 `pnpm verify:release`。该命令固定要求 pnpm 10.15.1，并依次执行受保护的测试库连通检查、类型检查、单元/集成测试、Chromium 与 WebKit 移动端 E2E、构建、镜像构建、Compose 迁移与健康检查、应用重启卷持久性，以及备份到全新 `poker_scorekeeper_restore_test` 的隔离恢复。恢复后还会用同一镜像连接恢复库，核验已完成历史和上传头像。任何 Docker CLI、daemon、buildx、Compose、测试库或浏览器能力缺失都会令命令失败，不会跳过发布关卡。

发布校验只使用 `docker-compose.test.yml` 的内部 MySQL 和按本轮随机标识命名的 Compose 项目；它绝不能连接 NAS 生产服务。脚本结束时只清理本轮 Compose 项目及其命名卷。若命令失败，应保留完整失败阶段和报告供审计，修复环境或代码后从头重跑，不要把失败阶段改成可选项。

## 6. 每日备份与 14 天保留

备份脚本先取得 `data/backups/.backup.lock`，再使用 MySQL 单事务、`--skip-add-locks` 导出，随后只打包头像目录顶层中已提交且符合受控命名的 `.webp` 文件；上传点文件、临时文件、目录和软链接不会进入归档。dump 不包含 `LOCK TABLES` 语句，恢复账号无需该权限。只有完整集合才发布校验文件和单调前进的 `latest-stamp`。密码来自容器环境的 `MYSQL_PASSWORD`，不会出现在命令参数或日志中。脚本只清理符合本项目精确数字时间戳命名且超过 14 天的普通文件。

同一备份目录只允许一个进程。若 NAS 断电留下 `.backup.lock`，先确认没有备份容器或 `mysqldump` 进程、校验 `latest-stamp` 指向的四件套完整，再用 `rmdir data/backups/.backup.lock` 删除空锁目录后重试；不要用递归删除。已提交上传头像采用 append-only，保证数据库快照引用的旧文件仍可归档，代价是孤儿文件会增长；在未来提供离线 GC 前不要手工清理。

先手动运行并检查：

```sh
docker compose exec -T app /app/scripts/backup/backup.sh
cat data/backups/latest-stamp
ls -la data/backups
```

然后在 DSM“控制面板 → 任务计划”新增每日任务，工作目录设为项目目录，命令只写：

```sh
docker compose exec -T app /app/scripts/backup/backup.sh
```

不要把密码附加到计划任务命令。应定期将 `data/backups` 加密复制到另一台设备或另一存储池；同盘备份不能防止磁盘或整机故障。

## 7. 恢复演练（只对隔离测试目标）

恢复脚本不会覆盖现有数据库，也拒绝活动式生产库名。目标必须是新的 `*_test` 或 `*_restore[_标识]` 数据库，并需要数据库名和完整动作二次确认。它先取得恢复父目录锁，再用同一非跟随、非阻塞文件描述符把四个输入限额快照；建库前验证 SHA-256、唯一 `format_version=1` 清单，并将 SQL gzip 在展开上限内完整流式验证，同时解析 USTAR 路径、类型和资源上限。默认上限为：SQL 压缩包 1 GiB/展开流 4 GiB、头像压缩包 256 MiB、总条目 10,000、单文件 8 MiB、展开总量 512 MiB；清单和 checksum 各固定 64 KiB，可用同名 `RESTORE_MAX_*` 环境变量调低或在硬上限内调高，完整名称见 [backup-restore.md](./backup-restore.md)。

下面只演练到新库和 `data/restore/avatars`。恢复账号的创建、`600` 专用环境文件、精确 GRANT、撤销和失败检查必须按 [backup-restore.md](./backup-restore.md) 执行。先保证目标为空并从 `latest-stamp` 读取备份标识：

```sh
mkdir -p data/restore/avatars
test -z "$(find data/restore/avatars -mindepth 1 -print -quit)"
STAMP=$(cat data/backups/latest-stamp)
RESTORE_DB=poker_scorekeeper_restore_drill
test -f "data/backups/checksums-$STAMP.txt"
test -f .env.restore
test "$(stat -c %a .env.restore)" = 600
```

随后执行操作卡中的 `docker run --env-file .env.restore` 命令；不要改用生产应用/备份账号，也不要把临时密码展开为 `-e MYSQL_PASSWORD=...`。

验证新库行数、管理员登录、历史战绩、结算金额和头像文件后，撤销并删除一次性账号及其环境文件。失败/TERM 只会删除已确认由本轮创建的库，并只在头像目录含本轮唯一 marker 时清理；外部竞态内容不会被误删。断电留下 `.restore.lock` 时必须确认无恢复进程并人工核验状态后仅用 `rmdir` 清空锁。若日志出现受控的 `restore cleanup failed`，必须人工确认新库和头像目录状态。生产切换必须另行安排停机窗口和人工复核；本脚本不会覆盖或重命名活动的 `poker_scorekeeper`。

## 8. 升级、回滚与日常排障

升级前先完成一次备份，并保留当前镜像标签：

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T app /app/scripts/backup/backup.sh
docker image tag poker-scorekeeper:local "poker-scorekeeper:rollback-$STAMP"
docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3000/api/health/ready
```

应用代码需回滚时，将保留的镜像重新标为 `poker-scorekeeper:local`，再执行 `docker compose up -d --no-build`。数据库迁移可能是向前兼容但不可自动逆转；如确需数据库回退，只能从备份恢复到新的隔离库，验证后在停机窗口人工切换，不能对活动库直接运行恢复脚本。

常用排障：

```sh
docker compose ps
docker compose logs --tail=200 app
curl -i http://127.0.0.1:3000/api/health/live
curl -i http://127.0.0.1:3000/api/health/ready
df -h /volume1/docker/poker-scorekeeper
```

日志为结构化输出并递归脱敏，但仍应限制 DSM 日志查看权限。Compose 已设置单文件 10 MiB、最多 3 个日志文件。不要在工单中粘贴 Cookie、Authorization、令牌、密码或数据库 URL。
