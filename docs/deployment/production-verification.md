# Production Verification

Status: `NOT_EXECUTED`

本文件尚无生产证据。当前环境没有 Docker CLI/daemon/Buildx/Compose，且尚未获得已轮换的新数据库凭据、bootstrap 管理员值、`SESSION_SECRET`、`CSRF_SECRET`、`PUBLIC_ORIGIN` 或群晖操作方式。因此未连接生产数据库、未部署容器、未配置反向代理、未执行真实手机验收，也未运行首次生产备份。

只有在 [production-checklist.md](./production-checklist.md) 全部完成后，才可用 `node scripts/verify-production.mjs --record` 以严格校验过的非秘密字段替换本文件。不得手工填造 digest、migration、health、backup 或 acceptance 时间。
