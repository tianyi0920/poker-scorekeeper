# 德州计分器备份与恢复操作卡

详细的群晖部署背景、权限和升级流程见 [synology.md](./synology.md)。本页用于值班时快速执行；任何恢复都只能写入新的隔离测试库，不能覆盖活动的 `poker_scorekeeper`。

## 每日备份

容器从权限为 `600` 的 `.env.production` 读取 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`、`BACKUP_DIR` 和 `AVATAR_ROOT`。不要把密码追加到命令行。

```sh
cd /volume1/docker/poker-scorekeeper
docker compose exec -T app /app/scripts/backup/backup.sh
STAMP=$(cat data/backups/latest-stamp)
test -f "data/backups/mysql-$STAMP.sql.gz"
test -f "data/backups/avatars-$STAMP.tar.gz"
test -f "data/backups/manifest-$STAMP.txt"
test -f "data/backups/checksums-$STAMP.txt"
```

脚本采用单事务导出，校验文件最后发布；失败集合不会更新 `latest-stamp`。保留任务只删除备份目录顶层中符合 `mysql-时间.sql.gz`、`avatars-时间.tar.gz`、`manifest-时间.txt`、`checksums-时间.txt` 模式且超过 14 天的普通文件。

## 隔离恢复演练

要求：四个文件来自同一个备份时间；`data/restore-avatars` 存在且为空；临时维护账户可新建数据库。维护密码必须通过受保护的容器环境文件注入，不能出现在 shell 参数或日志中。

```sh
cd /volume1/docker/poker-scorekeeper
test -z "$(find data/restore-avatars -mindepth 1 -print -quit)"
STAMP=$(cat data/backups/latest-stamp)
RESTORE_DB=poker_scorekeeper_restore_drill
docker compose exec -T \
  -e RESTORE_DATABASE="$RESTORE_DB" \
  -e CONFIRM_RESTORE_DATABASE="$RESTORE_DB" \
  -e CONFIRM_RESTORE_ACTION="RESTORE $RESTORE_DB" \
  -e SQL_ARCHIVE="/data/backups/mysql-$STAMP.sql.gz" \
  -e AVATAR_ARCHIVE="/data/backups/avatars-$STAMP.tar.gz" \
  -e MANIFEST_FILE="/data/backups/manifest-$STAMP.txt" \
  -e CHECKSUM_FILE="/data/backups/checksums-$STAMP.txt" \
  -e RESTORE_AVATAR_ROOT=/data/restore-avatars \
  app /app/scripts/backup/restore.sh
```

脚本会依次检查数据库名及两次确认、普通文件和同目录约束、三项 SHA-256、清单时间、归档路径、点文件、软/硬链接和特殊文件。目标数据库已存在或头像目录非空时会拒绝。导入失败会删除本次刚创建的隔离库并清理临时头像目录。

完成后人工核对用户数、已结束牌局数、结算汇总、管理员登录和头像。演练库和头像由管理员在确认目标绝对路径后单独清理；恢复脚本不会替你删除既有数据。生产切换必须另行安排停机、备份、双人复核和回滚窗口。
