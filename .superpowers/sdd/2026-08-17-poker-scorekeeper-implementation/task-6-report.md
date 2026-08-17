# Task 6 实施报告：审计轨迹与实时抽成设置

## 状态

完成。抽成设置可由所有已登录用户读取，仅超级管理员可更新；设置更新和 Task 5 用户管理动作均在原业务事务中追加审计。

## 实现内容

- 新增 `GET /api/settings/rake` 与 `PATCH /api/settings/rake`，共享契约为 `{ threshold: MoneyJson, bps, version }`。
- `threshold` 仅接受 0–9223372036854775807 范围内非负、规范化的整数元字符串，以字符串长度/字典序比较避免 JavaScript `Number` 精度损失；`bps` 仅接受 0–10000 整数；`version` 为正整数。
- 更新事务先锁定 `system_settings` singleton，再按现有确定顺序锁定操作人并重读角色，与 Task 5 生命周期锁序一致。
- 使用乐观 `version` 检查与递增，陈旧版本稳定返回 `409 SETTINGS_VERSION_CONFLICT`。
- 新增 `AuditService.record(transaction, entry)`，只接受 Prisma 事务客户端；记录失败会使业务修改整体回滚。
- 递归脱敏结合语义 token 与紧凑键族，覆盖 camelCase、全大小写、无分隔、下划线和连字符形式，并识别 `auth` 缩写；屏蔽 password/hash/token/cookie/authorization/API key/DB URL/connection string/secret 及其常见前后缀，同时不误杀 `secretSanta`、`monkeyValue`、`tokenizerMode` 等普通字段。
- 任意键下的 Basic/Bearer Authorization、Cookie、API key、数据库 URL 及 password/pwd 连接赋值，无论位于字符串开头或嵌入文本，都会整值替换；`requestId`、`sourceIp`、`userAgent` 也经同一安全入口清洗后再执行列长度截断。
- 循环引用、无效日期、抛错 getter 和 hostile Proxy 分别安全降级为 JSON 可序列化占位，不会令审计事务因序列化异常返回 500。
- 递归脱敏设置深度 32、节点 10000、数组长度 10000、字符串长度 16384 的硬上限，超限内容整值替换为对应占位，避免深层对象或大稀疏数组耗尽资源。
- `mustChangePassword` 仅在值确为 boolean 时作为安全状态字段保留；密码哈希及非布尔伪装仍被脱敏，密码重置审计可见 `false → true` 状态变化。
- 用户创建、昵称/抽成开关/角色/启用状态修改、密码重置、删除、恢复和管理员头像重置均审计 actor/action/entity/before/after。
- 用户审计快照仅从白名单公开字段构建，不将密码哈希、会话令牌、Cookie 或数据库地址交给审计序列化。
- 新增审计后，用户/头像 E2E 定向清理自己的审计行，不在测试库留下无主数据。

## TDD：RED / GREEN

- 初始 RED：脱敏 suite 因模块不存在失败；settings suite 因 Audit/Settings 模块不存在失败；9 个真实 HTTP 用户管理动作全部成功但数据库审计列表为空。
- 脱敏补充 RED：`db_url`/`api_key`/`credential_hash` 变体初次仍保留原值，1/3 失败；收紧键规则后 3/3 GREEN。
- 聚焦 GREEN：脱敏 3/3；settings 16/16；user audit 1/1。
- Task 5 联合回归 GREEN：用户 28/28、头像 13/13，与 Task 6 用例合计 58/58。
- 设置并发覆盖包括：同版本双请求仅一个成功；操作人在等待 singleton 锁时被降权，获锁后事务内重读并拒绝，设置与审计均不变。
- 真实 Prisma 事务抛错后审计记录为 0，证明审计参与外层事务回滚。
- 修复轮 RED：脱敏 9 项中 5 项失败（wrapper/凭据形态漏网和循环栈溢出）；settings 20 项中 2 项失败（BIGINT 上界外返回 500、审计元数据原样入库）。
- 修复轮 GREEN：脱敏 9/9、settings 20/20；覆盖 BIGINT 最大值成功、最大值加一稳定 400 且设置/审计不变，以及审计写入失败时客户端仅收到固定 `INTERNAL_ERROR`、设置与审计整体回滚。
- 修复轮 2 RED：脱敏 37 项中 18 项失败，稳定复现无分隔 password/session/cookie 键、`auth` 缩写、Basic/嵌入式凭据与连接赋值漏网，`mustChangePassword` 误杀及资源上限缺失；真实 settings/user-audit 21 项中 2 项失败，证明元数据原样入库且密码强制变更状态不可见。
- 修复轮 2 GREEN：脱敏拆分为 40/40，settings/user-audit 21/21；临时放宽四项资源阈值的 mutation 检查使深度、节点、稀疏数组、长字符串四项各自真实 RED，恢复阈值后全部 GREEN。

## 验证

所有数据库命令均先执行 `_test` 目标断言，未 reset，未输出连接串或凭据。

| 验证 | 结果 |
|---|---|
| Task 6 脱敏单测 | PASS，40/40 |
| Task 6 settings HTTP/DB E2E | PASS，20/20 |
| Task 5 + Task 6 聚焦 HTTP/DB E2E | PASS，62/62 |
| `pnpm test` | PASS，API 129/129；全仓 162/162 |
| `pnpm --filter @poker/api test:integration` | PASS，12/12 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| `.env.local` 跟踪/忽略检查 | PASS，未跟踪且已忽略 |
| 暂存与已跟踪内容高置信秘密扫描 | PASS，0 命中 |

## 测试库干扰调查

全仓首跑的唯一失败是 auth 的 4 个既有 bootstrap 用例找不到本轮账号。只读取证发现测试库存在一个旧 Task 5 测试残留的启用超管，导致 bootstrap 服务按设计跳过创建。该账号符合严格测试前缀，且 sessions/games/players/audits/settings/buyins/drafts/settlements 等所有引用计数均为 0。在 `_test` 断言后仅定向删除该行，复跑即全绿。测试结束后同样定向清理了 health suite 继承环境产生的 1 个零引用测试 bootstrap 账号。

修复轮复验同样先以 `_test` 断言、严格 `audit-<10hex>-bootstrap` 正则、全部用户关系计数为 0 且无 active-player lock 为事务内删除前置条件，定向清理旧夹具 1 行；全仓复验后再以相同守卫清理 health 遗留 1 行。未执行 reset，未接触生产库。

修复轮 2 全仓复验后以相同 `_test`、严格正则、零关系引用且无 active-player lock 守卫，定向清理 health 继承环境产生的 1 行测试 bootstrap；未执行 reset。

## 文件清单

- `apps/api/src/audit/`：审计模块、服务、递归脱敏与单元测试。
- `apps/api/src/settings/`：抽成设置模块、控制器与事务服务。
- `packages/contracts/src/settings.ts`：共享抽成设置请求/响应契约。
- `apps/api/src/users/users.service.ts`、`apps/api/src/uploads/avatar.service.ts`：Task 5 业务事务内审计。
- `apps/api/test/settings.e2e-spec.ts`、`apps/api/test/user-audit.e2e-spec.ts`：真实 HTTP/DB 权限、版本、并发、回滚和审计验证。
- `apps/api/vitest.config.ts`：让任务指定的 `src/**/*.test.ts` 参与常规测试。

## Concerns

- `AuditService` 已接受可选 `requestId/sourceIp/userAgent`；Task 6 业务调用在尚未引入全局请求上下文时，使用服务端生成的 request ID 与 `unknown` 来源字段。已批准计划的 Task 17 会引入全局 request ID 和 trusted proxy，届时可把真实请求元数据传入同一接口，无需改动审计事务边界。
- 既有 health E2E 会继承上一 suite 的 bootstrap 环境并在测试结束时留下一个零引用测试账号，这是 Task 5 报告已记录的夹具问题，不属于 Task 6 业务实现；本轮验证前后均只对严格前缀且零引用的测试行做定向清理。
