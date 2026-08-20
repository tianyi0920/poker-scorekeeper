# Docker Hub 多架构发布与极空间 NAS 部署设计

日期：2026-08-20
状态：已获用户批准，等待书面规格复核

## 1. 目标

将当前只能从源码在 NAS 上构建的部署方式，扩展为可从 Docker Hub 直接拉取固定版本镜像的生产部署方式。源代码存放在私有 GitHub 仓库，GitHub Actions 构建并发布公开的 AMD64/ARM64 多架构镜像。极空间 NAS 只保存 Compose、环境文件和持久数据，不保存或编译源代码。

本设计同时吸收用户在群晖部署时为解决 Prisma、Corepack 和容器启动问题所做的有效修改，但不照搬“删除自动数据库迁移”的临时绕过方案。正式镜像必须在不依赖运行时 Corepack 下载或可写缓存的前提下自动完成数据库迁移。

## 2. 已确认决策

- 私有 GitHub 仓库：`github.com/tianyi0920/poker-scorekeeper`
- 公开 Docker Hub 仓库：`docker.io/tianyi920/poker-scorekeeper`
- 首个正式版本：`1.0.0`
- 发布平台：`linux/amd64`、`linux/arm64`
- 极空间部署继续连接现有 MariaDB：`192.168.10.248:3306/poker_scorekeeper`
- 生产数据库目标安全门禁保持不变，不允许用环境变量把正式镜像指向任意数据库。
- 容器启动时自动运行数据库迁移；迁移失败时应用不得启动。
- Docker Hub 仓库公开，极空间拉取镜像不需要保存 Docker Hub 登录凭据。
- GitHub 源码仓库私有，生产密码和应用密钥不得进入 GitHub、Actions 日志或镜像。

## 3. 总体架构

发布链路如下：

1. 开发和验证在本地工作树完成。
2. 源码推送到私有 GitHub 仓库。
3. 普通分支和 Pull Request 只执行验证，不发布镜像。
4. 推送符合 `v<major>.<minor>.<patch>` 的正式 Git 标签时，GitHub Actions 运行完整发布门禁。
5. 门禁通过后，Buildx 构建 AMD64 和 ARM64 镜像，并推送固定版本与提交号标签。
6. 校验远端多架构清单和镜像身份后，才将同一摘要提升为 `latest`。
7. 极空间 NAS 使用固定版本标签拉取镜像，通过本地 `.env.production` 连接现有 MariaDB 和持久目录。

Git 标签 `v1.0.0` 对应 Docker 标签 `1.0.0`。另发布不可变追踪标签 `sha-<完整提交号>`。`latest` 只是便利标签，生产 Compose 默认固定到明确版本，而不是依赖 `latest`。

## 4. 运行镜像与启动流程

### 4.1 Dockerfile

保留多阶段构建。构建阶段使用锁定的 pnpm 版本安装依赖并生成 API、Web、contracts、settlement 和 Prisma 产物。最终运行镜像只包含：

- 编译后的应用与 Web 静态资源；
- 生产依赖；
- Prisma schema、迁移和生产所需 CLI；
- 数据库预检、健康检查、备份和恢复脚本；
- 固化的部署 ID。

最终镜像不包含 TypeScript 源码、测试、测试结果、`.env.production`、`.env.local` 或任何凭据。

运行阶段删除对 pnpm/Corepack 的需求，不再设置运行时 `PNPM_HOME`，也不在非 root 用户家目录创建 Corepack 缓存。Prisma 迁移直接调用生产依赖安装时生成的 `/app/apps/api/node_modules/.bin/prisma migrate deploy`。构建必须证明该文件存在、可执行，并能在只读根文件系统和 `node` 用户下运行。

镜像继续以 `node` 用户运行，保留 `tini -g --`、只读根文件系统、`no-new-privileges`、能力移除、受限临时目录和 OCI revision 标签。

### 4.2 entrypoint.sh

默认启动顺序固定为：

1. 运行 `production-preflight.mjs`，只允许目标为 `192.168.10.248:3306/poker_scorekeeper`。
2. 直接启动 Prisma CLI 子进程执行 `migrate deploy`。
3. 父进程转发 HUP、INT、TERM，并保留迁移程序的真实退出码。
4. 迁移退出码非零时立即停止容器。
5. 迁移成功后 `exec node apps/api/dist/main.js`。

显式一次性命令仍须先经过生产数据库预检；预检命令本身避免递归执行。不得采用“迁移失败后仍启动应用”或“完全跳过迁移”的降级路径。

## 5. Compose 与极空间部署包

现有 `docker-compose.yml` 保留为源码构建和生产验证入口。新增 `docker-compose.registry.yml`，其生产服务具备以下特征：

- 仅引用 `docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION}`；
- 不包含 `build:`；
- `POKER_IMAGE_VERSION` 必填，示例值为 `1.0.0`；
- 使用 `.env.production` 提供运行配置；
- 使用相对目录 `./data/avatars`、`./data/backups`、`./data/restore` 持久化数据；
- 默认只绑定 `127.0.0.1:3000:3000`，由同机反向代理提供公网 HTTPS；
- 保留健康检查、日志轮换、只读根文件系统、非 root 和安全选项；
- 不启动数据库容器，也不发布 3306 端口。

新增不含秘密的极空间环境模板。模板包含域名、版本、数据库 URL、Session/CSRF 密钥、bootstrap 管理员和备份账户字段的说明，但所有敏感值使用明确占位符。真实 `.env.production` 持续被 Git 忽略并要求仅所有者可读写。

新增极空间部署文档，覆盖：

- 建立项目目录和三个持久目录；
- 下载 Compose 和环境模板；
- 填写 `.env.production`；
- 拉取并启动固定版本；
- 检查 `live`、`ready` 和部署 ID；
- 配置同源 HTTPS/WebSocket 反向代理；
- 首次备份；
- 固定版本升级和回滚。

用户的现有公网域名、端口和密码属于实例配置，不写死到镜像或通用模板。

## 6. GitHub Actions 发布

新增发布工作流，原则如下：

- PR 和普通提交只执行验证。
- 只有符合语义版本格式的 Git 标签触发正式发布。
- 工作流使用最小权限；除检出私有源码外，不赋予仓库内容写权限。
- Docker Hub 登录只使用仓库 Secrets：`DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`。
- `DOCKERHUB_USERNAME` 固定为 `tianyi920`；令牌使用 Docker Hub 专用访问令牌，不使用账户密码。
- Actions 不持有生产数据库、管理员、Session 或 CSRF 凭据。
- 构建上下文受 `.dockerignore` 约束，秘密文件和测试输出不得进入上下文。

发布顺序：

1. 验证版本格式、提交状态和目标固定标签尚不存在。
2. 运行依赖锁定、秘密扫描、lint、类型检查、单元/集成/E2E 和构建。
3. 用隔离 MySQL 容器运行候选 AMD64 镜像。测试 Compose 明确替换生产 entrypoint，只直接调用镜像内同一个 Prisma 可执行文件后启动应用；这样不会放宽生产预检，也不会让 CI 连接生产数据库。该烟测验证迁移、健康检查、只读根文件系统、非 root 和卷持久性；生产 entrypoint 的“预检后才迁移”顺序由独立行为测试覆盖。
4. 使用 Buildx/QEMU 构建 `linux/amd64,linux/arm64`。
5. 推送 `1.0.0` 和 `sha-<commit>`，但暂不更新 `latest`。
6. 从 Docker Hub 重新读取 manifest，确认两个平台、OCI revision 和摘要。
7. 将已验证的固定版本摘要提升为 `latest`。
8. 输出版本、提交号、平台和最终 digest 作为发布证据。

固定版本标签不得指向不同摘要。如果固定版本已发布，工作流失败关闭。若固定版本已成功但提升 `latest` 失败，使用单独的受控恢复入口把已验证的固定版本摘要提升为 `latest`，不重写固定版本。

## 7. 验证与验收

### 7.1 代码级测试

- entrypoint 在预检失败、迁移失败和迁移成功时的行为；
- HUP、INT、TERM 信号转发和退出码；
- entrypoint 不调用 pnpm/Corepack；
- Dockerfile 运行阶段不包含 Corepack 下载或用户缓存；
- registry Compose 不含 `build:`，镜像名、固定版本、卷、健康检查和安全选项正确；
- 极空间模板没有真实凭据；
- GitHub Actions 触发条件、Secrets 名称、平台矩阵和标签策略；
- 发布脚本拒绝覆盖已有固定版本。

### 7.2 容器级测试

- AMD64 候选镜像在隔离 MySQL 上从空库自动迁移并启动；
- 迁移失败时应用端口不监听；
- 只读根文件系统和非 root 用户运行；
- `live`、`ready`、部署 ID 响应正确；
- 容器重启后头像和备份数据仍存在；
- 远端 manifest 同时包含 AMD64 和 ARM64；
- 拉取固定版本后，镜像内部署 ID、OCI revision 和 Git 提交一致。

### 7.3 首次生产验收

极空间首次部署只连接现有 MariaDB。执行前先备份现有生产库和头像。启动后验证：

- 自动迁移完成且应用健康；
- 管理员可登录；
- 现有用户、牌局、历史和头像可读取；
- WebSocket 连接正常；
- 反向代理只公开 HTTPS 入口，不公开 3000/3306；
- 首次备份生成完整四件套；
- 固定版本回滚操作卡可执行。

## 8. 失败处理

- 任一测试失败：不构建正式多架构镜像。
- 候选镜像迁移或健康检查失败：不推送固定版本。
- 任一架构构建失败：不发布版本。
- 远端 manifest 缺少平台或身份不一致：不更新 `latest`。
- 自动迁移失败：容器停止，保留日志，不启动旧代码连接未知 schema。
- 极空间升级失败：恢复上一固定镜像标签；数据库迁移不自动向后回滚。
- 如需数据库恢复，只从备份恢复到隔离库，验证后人工安排切换，不覆盖活动生产库。

## 9. 外部账号与授权边界

以下操作属于独立的外部写入步骤，实施时逐项确认后执行：

1. 创建私有 GitHub 仓库 `tianyi0920/poker-scorekeeper`；
2. 创建公开 Docker Hub 仓库 `tianyi920/poker-scorekeeper`；
3. 创建 Docker Hub 专用访问令牌；
4. 将用户名和令牌保存为 GitHub Secrets；
5. 首次推送源码；
6. 创建并推送 `v1.0.0` 标签，触发首次正式发布。

令牌不得粘贴到聊天、命令参数、Git 提交或日志中。若通过网页创建令牌，由用户在最终生成步骤接管，或在动作发生前进行单独确认；令牌生成后直接保存到 GitHub Secret，不回显。

## 10. 非目标

- 不迁移现有 MariaDB 到极空间。
- 不把数据库、生产密码或 `.env.production` 打包到镜像。
- 不自动修改群晖或极空间反向代理、路由器端口转发和证书。
- 不为每次普通提交发布 `latest`。
- 不在本任务中设计数据库向后迁移或活动生产库覆盖恢复。
- 不公开 GitHub 源代码仓库。

## 11. 完成标准

只有同时满足以下条件才视为完成：

- 本地代码和容器门禁全部通过；
- 私有 GitHub 仓库已建立且无秘密文件；
- GitHub Actions 成功发布 `1.0.0`、提交号标签和 `latest`；
- Docker Hub manifest 含 AMD64 和 ARM64；
- 极空间部署文档和模板可独立使用；
- 发布镜像在隔离数据库上完成自动迁移、健康检查和持久性验证；
- 生产凭据未进入 GitHub、Docker Hub、镜像或日志；
- 实际生产切换仍由用户在备份和动作确认后单独授权。
