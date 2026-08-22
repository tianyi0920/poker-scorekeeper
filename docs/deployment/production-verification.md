# Production Verification

Status: `NOT_EXECUTED`

本文件尚无生产证据。当前环境没有 Docker CLI/daemon/Buildx/Compose，且尚未获得已轮换的新数据库凭据、bootstrap 管理员值、`SESSION_SECRET`、`CSRF_SECRET`、`PUBLIC_ORIGIN` 或群晖操作方式。因此未连接生产数据库、未部署容器、未配置反向代理、未执行真实手机验收，也未运行首次生产备份。

只有在 [production-checklist.md](./production-checklist.md) 全部完成后，才可用 `node scripts/verify-production.mjs --record` 触发完整自动验收。脚本固定仓库根目录、`docker-compose.yml` 与项目名 `poker-scorekeeper`，清除继承的 Compose 目标覆盖，并从真实 Docker image label、运行容器只读 deployment 文件、`PUBLIC_ORIGIN` 同源 deployment 端点、Prisma、公开 health 与本轮 backup/recheck 采集同一部署证据。全部结果为 PASS 后才会以同目录临时文件、flush/fsync 和原子 rename 替换本文件；任何失败保留本页。不得通过环境变量或手工填造 deployment ID、digest、migration/checksum、health、backup 或 acceptance 时间。

## HTTPS/WSS 上线前与上线后检查（尚未执行）

部署 secret 文件必须保留在受限主机，不得提交真实值。上线前将其与 `.env.extremespace.example` 对照：所有 `CHANGE_ME` 占位符必须替换，`SESSION_SECRET` 与 `CSRF_SECRET` 必须独立且随机，并且不含秘密的 `PUBLIC_ORIGIN`、`WS_ALLOWED_ORIGINS` 两项均精确为 `https://pk.tianyi.wiki`。只允许核对这两个非秘密字段，不能打印整份部署文件或 secret：

```sh
grep -nE '^(PUBLIC_ORIGIN|WS_ALLOWED_ORIGINS)=' .env.production .env.extremespace.example
```

从管理电脑的 PowerShell 运行以下精确公网检查：

```powershell
curl.exe -fsSI https://pk.tianyi.wiki/api/health/live
curl.exe -fsS -D - -o NUL "https://pk.tianyi.wiki/socket.io/?EIO=4&transport=polling"
```

健康检查必须成功，polling 请求必须返回 Socket.IO 响应。然后在浏览器 Network 面板确认同源 `/socket.io` 的 WebSocket 为 `101 Switching Protocols`，并检查实际页面响应的 `Content-Security-Policy`：`connect-src` 必须包含 `wss://pk.tianyi.wiki`。任一项出现 HTTP、`ws://`、mixed-content 或 CSP 拒绝时停止上线并修正 TLS 入口或环境配置；本仓库不包含真实部署 secret，也不会替代一次真实浏览器验收。
