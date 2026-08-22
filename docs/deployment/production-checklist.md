# 生产上线检查表

本清单是生产变更的硬门禁，不是可跳过的建议。当前仓库只完成了离线实现与测试；尚未连接 `192.168.10.248:3306/poker_scorekeeper`，也未在 NAS 创建目录、数据库、容器、TLS 终止层、防火墙规则或备份。

## 0. 停止条件

任一项不满足就停止，不运行后续生产命令：

- [ ] 对话中暴露过的旧数据库密码已在 MariaDB 侧轮换并失效；禁止把旧值作为回退。
- [ ] 新数据库凭据只存在于群晖上未跟踪、权限为 `600` 的 `.env.production`。
- [ ] 已准备唯一的 bootstrap 超级管理员账号、初始密码和不同的新管理员密码。
- [ ] `SESSION_SECRET` 与 `CSRF_SECRET` 分别为独立、足够强的随机值，未进入 Git、终端历史或日志。
- [ ] `PUBLIC_ORIGIN` 精确为无用户名、密码、路径、查询串或片段的 `https://pk.tianyi.wiki`。
- [ ] `WS_ALLOWED_ORIGINS` 精确为 `https://pk.tianyi.wiki`；不得使用 `*`、HTTP 或未记录的额外来源。
- [ ] `DEPLOYMENT_ID` 已固定为本次 Git revision 或发布 ID；它是非秘密值，且构建后不再修改。
- [ ] 已取得明确、可审计的群晖操作方式和停机/上线窗口。
- [ ] 群晖具备 Docker CLI、daemon、Buildx 与 Docker Compose 2.34.0 或更高版本。
- [ ] `git status --short` 为空，当前提交已通过完整发布校验；不得用跳过参数绕过失败 gate。

## 1. 固定目标与文件权限

- [ ] `DATABASE_URL` 精确指向 `192.168.10.248:3306/poker_scorekeeper`。
- [ ] `.env.production` 中的 `DEPLOYMENT_ID` 符合 `^[a-z0-9][a-z0-9._-]{7,63}$`，且对应本轮待部署代码。
- [ ] `MYSQL_HOST=192.168.10.248`、`MYSQL_PORT=3306`、`MYSQL_DATABASE=poker_scorekeeper`。
- [ ] 生产 Compose 中只有 `app` 服务，设置 `PORT=80`、`net.ipv4.ip_unprivileged_port_start=0`，且端口映射精确为 `127.0.0.1:3000:80`；应用 TCP 80 不得直接对公网或局域网发布。
- [ ] 已在 `/volume1/docker/poker-scorekeeper` 内执行：

  ```sh
  install -d -m 750 /volume1/docker/poker-scorekeeper/data/avatars
  install -d -m 750 /volume1/docker/poker-scorekeeper/data/backups
  install -d -m 750 /volume1/docker/poker-scorekeeper/data/restore
  chmod 600 /volume1/docker/poker-scorekeeper/.env.production
  ```

- [ ] `git check-ignore .env.production` 成功；没有打印、截图或复制文件内容。

## 2. 只读预检、建库、迁移与启动

在项目目录执行；每一步失败都停止：

```sh
cd /volume1/docker/poker-scorekeeper
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production config --quiet
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production build --pull
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production run --rm app node scripts/database/production-preflight.mjs
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production run --rm app node scripts/database/create-database.mjs
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production run --rm app /app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production up -d
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production ps
```

- [ ] 预检只报告数据库版本、当前库、`utf8mb4`、建库能力与使用能力；输出没有 URL 或凭据。
- [ ] 建库与迁移前的生产目标门禁均通过；任何其他主机、端口或库名均被拒绝。
- [ ] 应用健康状态为 healthy，`/api/health/live` 与 `/api/health/ready` 均成功。
- [ ] 镜像 OCI revision label、容器内 `/app/deployment-id` 与公开 `/api/health/deployment` 返回同一个 `DEPLOYMENT_ID`。
- [ ] `_prisma_migrations` 与仓库中已提交的 migration 集合一致。
- [ ] 仅将应用容器 80 绑定到主机回环 `127.0.0.1:3000`；没有向局域网或公网发布应用端口、3306 或 8306。

## 3. HTTPS/WSS 网络边界

- [ ] OpenResty TLS 终止层以 `https://pk.tianyi.wiki` 对公网提供 443，并将普通请求及同源 `/socket.io` 的 Upgrade 请求代理到私有回环后端 `http://127.0.0.1:3000`；不得将应用 TCP 80、3000、3306、8306 或管理端口直接公开到公网。
- [ ] `pk.tianyi.wiki` 的 DNS 指向 TLS 终止层；防火墙只允许公网访问该层的 HTTPS 端口，应用容器仅接受来自该层或受控私有网络的流量。
- [ ] 从管理电脑 PowerShell 已成功执行以下 HTTPS health 与 Socket.IO polling 检查：

  ```powershell
  curl.exe -fsSI https://pk.tianyi.wiki/api/health/live
  curl.exe -fsS -D - -o NUL "https://pk.tianyi.wiki/socket.io/?EIO=4&transport=polling"
  ```

- [ ] 浏览器 Network 面板中同源 `/socket.io` 的 WebSocket 为 `101 Switching Protocols`；实际页面的 `Content-Security-Policy` 的 `connect-src` 包含 `wss://pk.tianyi.wiki`，且没有 mixed-content 或 CSP 拒绝。
- [ ] HSTS 仅在 HTTPS 生产来源上启用；未接受 HTTP/WS 明文传输密码、Cookie 或牌局数据。

## 4. 可逆验收

先创建权限为 `600`、不受 Git 跟踪的 `.env.acceptance`，只放 bootstrap 用户名、当前初始密码、不同的新管理员密码及 `PUBLIC_ORIGIN`。不要在命令行中展开这些值。

```sh
chmod 600 .env.acceptance
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production run --rm --env-from-file .env.acceptance app node scripts/verify-production.mjs
```

- [ ] 自动验收通过公开 HTTPS/WSS 源站完成登录、CSRF、强制改密、临时普通用户创建、空局创建/开启、WebSocket 房间加入、确认离开、空局作废与临时用户逻辑删除。
- [ ] 最终上线直接在第 5 节运行一次 `--record`（其内部包含同一完整自动验收）；不要先运行本节命令再无意义地重复改密。若为排障单独运行过本节，必须按下一项更新当前/新密码后才能继续。
- [ ] 输出只包含固定 PASS 字段与 UTC 时间，不含源站、账号、对象 ID、Cookie 或密码。
- [ ] 如果脚本在强制改密后失败，重跑前把受保护验收文件中的“当前密码”更新为刚设置的新值，并再提供一个不同的新密码；禁止回退到已失效的初始值。
- [ ] 使用真实手机关闭 Wi-Fi 后通过公网 HTTPS 登录，并进入一场空验收局；管理员侧确认该手机通过 WSS 出现在观战者列表。这个人工步骤不能由 Node 客户端替代。
- [ ] 未购买筹码，未生成虚假结算或任何生产财务记录。
- [ ] 已确认空验收局为 `VOIDED`，临时用户已逻辑删除。
- [ ] 已从 `.env.production` 移除 bootstrap 三项并安全删除 `.env.acceptance`；不要保留旧初始密码。

## 5. 首次备份与无秘密证据

```sh
docker compose --file docker-compose.yml --project-name poker-scorekeeper --env-file .env.production exec -T app node scripts/database/production-backup-target.mjs
# 在能控制本项目生产 Compose 的 Docker/Node 24 管理工作副本最终执行一次；不要在 app 容器内运行。
node --env-file=.env.production --env-file=.env.acceptance scripts/verify-production.mjs --record
```

- [ ] `latest-stamp` 指向本次完整的 SQL、头像、manifest 与 checksum 集合。
- [ ] checksum 文件内的三条 SHA-256 与对应文件重新计算结果一致。
- [ ] 记录器固定仓库根目录、Compose 文件和项目名并清除继承的 Compose 目标覆盖；它从真实 Docker image inspect、镜像/容器/公开端点一致的 deployment ID、Prisma migrate status、只读 `_prisma_migrations` checksum、公开 health 与本轮 backup/recheck 采集证据，不接收形似 PASS 的环境值。
- [ ] 记录本轮浏览器的 Socket.IO `101 Switching Protocols` 与实际 CSP 中 `wss://pk.tianyi.wiki` 的验收证据；不得以本地 HTTP 或 polling 响应替代 WSS 升级检查。
- [ ] 全部证据和本轮自动验收均为 PASS 后，记录器才以同目录临时文件写入、flush/fsync 并原子替换 `docs/deployment/production-verification.md`；任何失败保留旧记录。
- [ ] 复核验证记录不含主机凭据、连接 URL、Cookie、用户密码或令牌。

## 6. 上线结论

- [ ] 所有检查项完成，且 `docs/deployment/production-verification.md` 不再标记 `NOT_EXECUTED`。
- [ ] 生产验证文档单独提交；不得 `push`、合并或扩大生产权限，除非用户另行明确授权。
