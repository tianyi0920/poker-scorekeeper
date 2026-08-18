# 德州计分器备份与恢复操作卡

详细部署背景见 [synology.md](./synology.md)。任何恢复都只能写入新建的隔离测试库，不能覆盖活动的 `poker_scorekeeper`。

## 每日备份

容器从权限为 `600` 的 `.env.production` 读取数据库及备份环境变量；密码不得出现在命令参数或日志中。

```sh
cd /volume1/docker/poker-scorekeeper
docker compose exec -T app /app/scripts/backup/backup.sh
STAMP=$(cat data/backups/latest-stamp)
test -f "data/backups/mysql-$STAMP.sql.gz"
test -f "data/backups/avatars-$STAMP.tar.gz"
test -f "data/backups/manifest-$STAMP.txt"
test -f "data/backups/checksums-$STAMP.txt"
```

脚本以 `data/backups/.backup.lock` 串行化同目录备份：先用 `--single-transaction --skip-lock-tables --skip-add-locks` 做数据库 dump，再只归档头像根目录顶层中符合已提交文件命名的 `.webp`；点文件、上传临时文件、软链接、子目录和其他文件均排除。dump 不写 `LOCK TABLES` 语句，所以一次性恢复账号无需 `LOCK TABLES` 权限。校验文件最后无覆盖发布，`latest-stamp` 只前进不倒退；14 天保留只匹配严格数字时间戳文件名。

断电可能留下锁目录。先用 `docker compose ps`、`docker compose top app` 确认没有备份或 `mysqldump`，并核验 `latest-stamp` 四件套后，只执行 `rmdir data/backups/.backup.lock`；不要递归删除。已提交头像为 append-only，旧历史引用因此稳定，但孤儿文件会积累；上线离线 GC 前不要人工删头像。

## 隔离恢复演练

### 1. 一次性最小权限账号

先确定唯一的新目标库名，例如 `poker_scorekeeper_restore_drill`。在受控的 MariaDB 管理终端中交互输入管理员密码，再执行以下 SQL；示例密码只是占位符，实际值不得写入仓库或 shell 历史。

```sql
CREATE USER 'poker_restore_once'@'%' IDENTIFIED BY '<temporary-generated-password>';
GRANT CREATE, DROP, ALTER, INDEX, INSERT, UPDATE, DELETE, SELECT,
      REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER
ON poker_scorekeeper_restore_drill.* TO 'poker_restore_once'@'%';
```

该账号没有活动生产库权限，也不需要 `LOCK TABLES`；备份不导出 routines/events，表触发器则由已有的 `TRIGGER` 权限恢复。`%` 仅用于短时演练并依赖 NAS 防火墙，演练后必须立即删除。若环境能固定容器源网段，应把 `%` 换成更窄的 host 匹配。

### 2. 专用环境文件

创建不提交的 `.env.restore`，立即设置为仅所有者可读写，再用编辑器填写临时密码：

```sh
cd /volume1/docker/poker-scorekeeper
install -m 600 /dev/null .env.restore
```

```dotenv
MYSQL_HOST=192.168.10.248
MYSQL_PORT=3306
MYSQL_USER=poker_restore_once
MYSQL_PASSWORD=<temporary-generated-password>
```

准备可写父目录及其普通空子目录。Compose 只 bind mount 父目录 `/data/restore`，绝不能把 `/data/restore/avatars` 本身做 mount，否则原子 `rmdir`/`mv` 无法完成。

```sh
mkdir -p data/restore/avatars
sudo chown -R 1000:1000 data/restore
chmod 700 data/restore data/restore/avatars
test -z "$(find data/restore/avatars -mindepth 1 -print -quit)"
```

### 3. 执行恢复

以下使用 `docker run --env-file`，密码只经受保护文件进入环境，不进入 argv 或日志。备份卷只读，恢复父目录可写；`--entrypoint` 跳过应用迁移入口。

```sh
STAMP=$(cat data/backups/latest-stamp)
RESTORE_DB=poker_scorekeeper_restore_drill
docker run --rm --read-only --tmpfs /tmp:size=64m,mode=1777 \
  --env-file .env.restore \
  -e RESTORE_DATABASE="$RESTORE_DB" \
  -e CONFIRM_RESTORE_DATABASE="$RESTORE_DB" \
  -e CONFIRM_RESTORE_ACTION="RESTORE $RESTORE_DB" \
  -e SQL_ARCHIVE="/data/backups/mysql-$STAMP.sql.gz" \
  -e AVATAR_ARCHIVE="/data/backups/avatars-$STAMP.tar.gz" \
  -e MANIFEST_FILE="/data/backups/manifest-$STAMP.txt" \
  -e CHECKSUM_FILE="/data/backups/checksums-$STAMP.txt" \
  -e RESTORE_AVATAR_PARENT=/data/restore \
  -e RESTORE_AVATAR_ROOT=/data/restore/avatars \
  -v "$PWD/data/backups:/data/backups:ro" \
  -v "$PWD/data/restore:/data/restore" \
  --entrypoint /app/scripts/backup/restore.sh \
  poker-scorekeeper:local
```

恢复先取得 `/data/restore/.restore.lock`，再以 `O_NOFOLLOW|O_NONBLOCK` 打开每个输入，并通过同一文件描述符 `fstat`、限额流式复制到 `O_EXCL` 私有快照；FIFO、设备、软链接、初始超限或复制中增长超限都会在建库前拒绝。清单和校验文件各固定上限 64 KiB。建库前还会验证 gzip、三项 SHA-256、完整且字段唯一的 `format_version=1` 清单，并流式解析 tar header 检查路径、类型、数量和体积，不把无界 tar listing 写入磁盘。默认/硬上限如下；如需调整，只能通过 `.env.restore` 中的变量在硬上限内设置正整数：

| 变量 | 默认值 | 硬上限 |
| --- | ---: | ---: |
| `RESTORE_MAX_SQL_BYTES` | 1 GiB | 4 GiB |
| `RESTORE_MAX_SQL_EXPANDED_BYTES` | 4 GiB | 16 GiB |
| `RESTORE_MAX_AVATAR_ARCHIVE_BYTES` | 256 MiB | 1 GiB |
| `RESTORE_MAX_AVATAR_ENTRIES` | 10,000 | 100,000 |
| `RESTORE_MAX_AVATAR_FILE_BYTES` | 8 MiB | 16 MiB |
| `RESTORE_MAX_AVATAR_TOTAL_BYTES` | 512 MiB | 4 GiB |

SQL 导入还经过展开字节流限额；超限会让 `pipefail` 触发并删除本轮已确认创建的库。失败或 TERM 只会删除 `CREATE DATABASE` 已明确成功的本轮库；头像目标只有包含本轮唯一 ownership marker 时才会删除并重建，外部竞态写入不会被递归清理。成功的演练头像目录会保留隐藏 ownership marker，应用和后续备份均不暴露/归档它。

断电或 `SIGKILL` 可能留下 `/data/restore/.restore.lock`。先用 `docker ps`/`docker top` 确认没有恢复进程，再人工核对目标库、头像目录和 marker 的完整状态；只能对确认属于已终止演练的空锁目录执行 `rmdir data/restore/.restore.lock`，不得递归删除。若临时账号权限不足，脚本会输出不含凭据的 `restore cleanup failed`；此时立即人工检查，不能假设清理成功。

### 4. 核验、撤权和删除凭据

成功后核对新库用户数、已结束牌局、结算汇总、管理员登录、历史头像；失败后则确认目标库不存在且头像目录为空。可在管理终端中执行：

```sql
SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA
WHERE SCHEMA_NAME = 'poker_scorekeeper_restore_drill';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'poker_restore_once'@'%';
DROP USER 'poker_restore_once'@'%';
```

最后删除临时凭据文件，并再次确认权限账号已不存在：

```sh
rm -f .env.restore
test ! -e .env.restore
```

演练库和头像只由管理员在确认绝对目标后单独清理。生产切换必须另行安排停机、双人复核和回滚窗口；本脚本永不覆盖活动 schema。
