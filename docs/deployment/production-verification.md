# Production Verification

Status: `NOT_EXECUTED`

本文件尚无生产证据。当前环境没有 Docker CLI/daemon/Buildx/Compose，且尚未获得已轮换的新数据库凭据、bootstrap 管理员值、`SESSION_SECRET`、`CSRF_SECRET`、`PUBLIC_ORIGIN` 或群晖操作方式。因此未连接生产数据库、未部署容器、未配置反向代理、未执行真实手机验收，也未运行首次生产备份。

只有在 [production-checklist.md](./production-checklist.md) 全部完成后，才可用 `node scripts/verify-production.mjs --record` 触发完整自动验收，并从真实 Docker、Prisma、公开 health 与本轮 backup/recheck 采集证据。全部结果为 PASS 后才会以同目录临时文件、flush/fsync 和原子 rename 替换本文件；任何失败保留本页。不得通过环境变量或手工填造 digest、migration/checksum、health、backup 或 acceptance 时间。
