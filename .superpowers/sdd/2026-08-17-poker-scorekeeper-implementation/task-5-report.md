# Task 5 实施报告：用户管理与头像管线

## 状态

完成。用户管理、生命周期约束、会话撤销、头像预设与安全上传管线均已实现，并通过真实 HTTP、测试数据库与临时文件系统行为验证。

## 实现内容

- 新增用户管理路由：列表、创建、修改、逻辑删除、恢复、管理员重置密码。
- 权限遵循简报：`ADMIN` 仅可创建 `USER`，可修改普通用户昵称与 `rakeEnabled`，并可重置普通用户密码/头像；不可修改角色、启用状态或管理员。`SUPER_ADMIN` 可创建所有角色、修改、逻辑删除与恢复。
- 用户名按 `trim + NFKC + lower-case` 永久唯一；启用用户昵称按中文区域 lower-case 归一并唯一。删除释放昵称，恢复时重新检查冲突，也可在同一事务中提供替代昵称后恢复；历史对局快照不被修改。
- 删除、禁用、任意角色等级下降均先锁定 singleton 生命周期协调行，再按用户 ID 确定顺序锁定 actor/target，检查 `ActivePlayerLock`，并锁定/计数启用超级管理员；这既保护最后一个超级管理员，也消除 actor/target 交叉与双超管并发修改的锁顺序死锁。
- 创建、修改、重置密码、重置头像均在事务内锁定并重读 actor，依当前 `role/isActive/deletedAt` 重新授权，因此请求途中被降权、禁用或删除会立即被拒绝。
- 角色或启用状态改变立即撤销目标用户全部活动会话；管理员重置密码会设置 `mustChangePassword` 并撤销会话。
- 新增 12 个稳定、受控的预设头像 ID 与 256×256 WebP 静态资源。
- 上传最大 5 MiB，仅接受实际可解码且 MIME 与内容一致的 JPEG/PNG/WebP；限制至 4096×4096 和 16 MP，服务端通过 Sharp 居中裁切并重编码为 256×256 WebP。
- 上传使用受控 UUID 文件名和临时文件；转换成功后才更新数据库，提交后才清理旧文件；提交失败保留旧文件并删除新/临时文件；路径穿越值不会被跟随删除。
- 头像持久化根目录统一读取部署约定的 `AVATAR_ROOT`；E2E 同时设置旧键到另一个临时目录，证明文件只写入 `AVATAR_ROOT`。
- 扩展统一错误码和 HTTP 413 映射；共享响应契约可解析真实 JSON 日期字符串。
- API 测试强制单 fork，并在 `NODE_ENV=test` 时将每个 Prisma 连接池上限从 10 收紧为 3，避免 auth 并发启动多个 Nest/Prisma 实例时耗尽共享测试库连接；生产仍为 10。头像测试仅使用测试临时目录。

## TDD：RED / GREEN

严格先测试后实现，测试面向真实 Nest HTTP、Prisma 测试数据库和磁盘文件，不以 mock 或源文本断言替代行为验证。

- 用户管理初始 RED：`users.e2e-spec.ts` 14/14 失败，路由返回 404。
- 头像管线初始 RED：`avatars.e2e-spec.ts` 9/9 失败，路由不存在（超大 multipart 在缺失路由阶段连接被重置）。
- 初次 GREEN：用户 14/14、头像 9/9。
- 复审补充 RED：并发插入 active-player lock 时更新错误成功；管理员重置密码/头像在目标并发晋升后错误成功；真实 JSON 日期响应不符合共享 schema；multipart 413 被映射成 `INTERNAL_ERROR`。
- 独立复审追加 RED：两个不同超级管理员被并发禁用时，一个事务因锁顺序死锁而 rejected。
- 最终 GREEN（原任务）：新增 singleton 生命周期协调锁，并验证双超管并发变更无死锁；另以真实事务覆盖反向顺序，游戏加入等待生命周期提交后重读 `isActive/deletedAt`，不会为已禁用用户创建活动锁。
- 修复轮 RED：用户/头像聚焦用例确认 5 类缺口：管理员普通字段修改返回 403；`ADMIN→USER` 对活动玩家错误成功；旧昵称被复用后恢复返回 409；创建/修改/密码重置/头像重置的 actor 途中失权仍错误成功；头像仍写入旧 `AVATAR_UPLOAD_ROOT`。每项均是真实 HTTP 或服务调用 + 真实测试数据库/临时文件系统的失败。
- 修复轮 GREEN：用户 27/27、头像 13/13，聚焦合计 40/40。反向 actor/target 锁顺序、事务内重授权、角色等级下降、替代昵称恢复和提交失败文件清理均经过真实并发/文件行为回归。

## 脱敏验证命令与结果

所有需要数据库配置的命令均静默读取被 Git 忽略的 `.env.local`，先运行 `node scripts/database/assert-test-database.mjs` 验证目标包含 `_test`；未输出连接串，未执行 reset。

| 验证 | 结果 |
|---|---|
| `pnpm --filter @poker/api test:e2e -- users.e2e-spec.ts avatars.e2e-spec.ts` | PASS，40/40 |
| `pnpm test` | PASS，API 67/67；contracts 3/3；settlement 14/14；web 1/1；全仓 85/85 |
| `pnpm --filter @poker/api test:integration` | PASS，12/12 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| 预设资源 Sharp 元数据检查 | PASS，12 个文件均为 256×256 WebP |
| `.env.local` 跟踪检查 | PASS，被忽略且未跟踪 |
| 暂存内容高置信秘密模式扫描 | PASS，0 命中 |

说明：修复轮中旧的每实例 10 连接配置在 auth 并发启动多个 Nest/Prisma 实例后稳定复现 `P2028: Unable to start a transaction in the given time`，导致后续 suite 启动失败，但 users 已 27/27，且无业务断言失败。将测试环境每实例上限收紧为 3 后，同样全仓命令中 auth 22/22 与后续套件全部通过。一次未加载本地环境的 `typecheck` 尝试在 Prisma generate 阶段按预期拒绝缺失的 `DATABASE_URL`；随后按上述安全流程静默加载并验证 `_test` 后，`typecheck` 与 `build` 均通过。全程未泄露配置值、未 reset 数据库。

## 文件清单

- `apps/api/src/users/`：用户控制器、服务、权限策略、确定锁顺序、归一化与模块。
- `apps/api/src/uploads/`：头像控制器、服务与预设清单。
- `apps/api/test/users.e2e-spec.ts`、`apps/api/test/avatars.e2e-spec.ts`：真实 HTTP/数据库/文件 E2E。
- `packages/contracts/src/users.ts`、`packages/contracts/src/avatars.ts`、`packages/contracts/src/index.ts`：共享契约，包括可选替代昵称的恢复请求。
- `apps/api/src/prisma/prisma.service.ts`：仅测试环境使用有界连接池。
- `apps/web/public/avatars/preset-01.webp` 至 `preset-12.webp`：预设资源。
- `apps/api/src/app.module.ts`：注册用户模块。
- `apps/api/src/common/errors/`：新增领域错误和 413 映射。
- `apps/api/package.json`、`apps/api/vitest.config.ts`：契约预构建和稳定的串行测试配置。

## 自审与独立复审

- 检查全部路由、角色矩阵、错误码、归一化、删除/恢复、会话撤销和头像限制与任务简报一致。
- 检查事务顺序：生命周期协调行、按 ID 排序的 actor/target、活动锁/超管集合采用统一顺序；授权和生命周期检查在锁内重新读取；数据库提交前不删除旧文件。
- 检查上传边界：真实内容解码、严格 MIME、像素/尺寸限制、受控 UUID 文件名、临时写入、路径穿越保护、失败清理。
- 独立复审发现的 active-player 双向并发协议、超管生命周期死锁、actor 授权 TOCTOU、任意角色降级、冲突昵称恢复、持久卷环境键、提交失败文件清理、JSON 日期契约和 413 映射均已以回归测试修复或固化。
- 修复后独立复审确认无剩余 Critical/Important 问题，并确认 singleton 锁顺序与反向游戏加入协议表述准确。

## Concerns

- Task 4 认证行为按要求保持不变。它在每个受保护请求都会重新读取用户角色/启用状态，因此已有会话即时失效；但“登录已验证、管理事务随后提交、登录事务最后创建新会话”的极窄并发窗口属于 Task 4 登录事务边界，本任务未修改认证实现。
- 后续游戏加入实现必须沿用已由真实事务回归固定的协议：先锁定用户，重新读取 `isActive/deletedAt`，确认仍可加入后才创建 `ActivePlayerLock`。裸写该表会绕过跨表业务不变量。
- 旧头像清理在数据库提交后执行并带重试；永久性文件系统拒绝时会记录告警而不把已提交的成功响应改成 500，因此仍可能需要运维清理孤儿文件。生产部署必须将 `AVATAR_ROOT` 指向预期的 NAS/持久卷；测试从未写入真实 NAS。
