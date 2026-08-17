# Task 9 实施报告：Socket.IO 对局房间、观战在线状态与重连快照

## 状态

完成。已交付同源 Socket.IO Gateway、Cookie 会话握手鉴权、按对局隔离的房间、按 `(game, user)` 连接引用计数的内存观战状态、完整数据库快照重连，以及牌局/购买/抽成规则提交后的实时事件。广播是事务提交后的尽力通知；广播失败不会把已经提交的 HTTP 写入改成 500，重连始终从数据库完整快照恢复。

实施提交：本任务使用单一实现提交，提交号见 Git 历史。

## 实现内容

- 新增共享 realtime contracts：严格的 `game.join { gameId, knownVersion }`、`game.leave { gameId }`、显式成功/失败 ack，以及 `game.snapshot`、`game.updated`、`presence.updated`、`rake-settings.updated`、`player-rake.updated`、`server.error` 事件结构。
- Gateway 使用默认同源 Socket.IO 端点，不配置跨域；握手从 `poker_session` Cookie 读取原始令牌，复用 `SessionService.authenticateRawToken` 的 SHA-256 token hash、撤销/闲置/绝对过期、用户启用/逻辑删除校验。缺失、伪造、过期、撤销、停用和强制改密会统一以 `UNAUTHENTICATED` 拒绝，不返回内部查询或 token 信息。
- Socket 只读命令不要求 CSRF；每次 join/leave 和每次服务端广播前重新验证数据库会话。角色变化、停用、删除、密码重置、注销以及修改密码撤销其他会话时，通过 SessionService 的进程内失效通知立即断开对应 session/user 的全部 socket。
- `PresenceService` 仅保存 `(gameId -> userId -> socketId set)`，不写财务表。同一用户两个 tab 只显示一次，关闭一个 tab 仍在线，最后一个连接离开才删除；leave、disconnect 和单 socket 换房都会清理旧引用。
- 观战列表每次读取当前启用用户资料，并查询 `game_players` 排除已入座玩家；HTTP `/games/current`、`/:id/snapshot` 和 WebSocket 完整快照共用同一真实 presence 数据。
- join 先复用 Task 7 的 `assertCanViewGameSnapshot` 权限，再加入 `game:<id>` 房间。`knownVersion` 与当前版本不同时发送完整 `game.snapshot`；相等时不重复快照，但 ack 明确返回当前版本和 `snapshotSent: false`，不会悬挂。
- `GameEventsService` 在每次发事件前逐 socket 重验会话和 viewer 权限。对局完成后，非参战普通观战者会收到受控 `FORBIDDEN` 并被移出房间；参战者和管理员边界沿用 Task 7 策略，不泄漏已完成牌局。
- 游戏创建/开启/进入结算/作废、购买/更正、全局抽成更新和用户抽成开关更新都在数据库事务成功返回后广播；事务抛错不广播。广播自身异常被隔离，不改变已提交 HTTP 结果。
- 全局抽成更新向全部 `ACTIVE`/`SETTLING` 房间发送 `{ version }`；个人抽成更新通过 `active_player_lock` 定位所在牌局并发送 `{ userId }`。
- 不存在服务端秒级计时事件；前端继续依据快照中的 `startedAt`、`serverNow` 自行计算经过时间。
- 应用仍是单实例架构；没有引入 Redis、消息队列或额外容器。

## TDD：RED / GREEN

- 首轮真实 Socket RED：在 Gateway 尚未注册时，缺失 Cookie 与伪 Cookie 两项都只得到底层 `websocket error`，预期受控 `UNAUTHENTICATED`，2/2 失败。
- 首版 GREEN 先通过 TypeScript 编译修正，再运行真实 Socket.IO client；首轮全套 9/12，通过鉴权、版本、重连和多数事件，剩余三个均为测试隔离/fixture 问题：异步 presence 监听捕获旧事件、同一玩家跨桌购买触发正确业务冲突、reset-password 留下 `mustChangePassword=true`。
- 修复测试绑定和 fixture 恢复后，realtime 14/14；随后新增过期/撤销/停用握手、显式 presence 到达/离开、无 timer tick、COMPLETED 权限边界，最终 realtime 17/17。
- 买入回归与 realtime 合跑 37/37；确认 600 元断线恢复、房间隔离、回滚不广播、广播失败 HTTP 仍成功。
- integration 首轮 30/31：schema 基线发现 singleton version 为 3。只读核对确认这是本任务早期 rake 事件测试在加入 settings 恢复前遗留；仅在已硬断言 `_test` 的测试库把该 singleton 恢复 migration 默认值，未 reset。重跑 integration 31/31。

## 验证

所有数据库测试在连接前硬断言目标数据库名以 `_test` 结尾；未执行 reset，未输出连接串或凭据。测试 suite 保存并恢复全局 settings，最终核对 migration 默认值、`realtime-*` 用户和牌局残留均为零。

| 验证 | 结果 |
|---|---|
| Realtime shared contracts | PASS，30/30 contracts 全包，其中 realtime 6/6 |
| Task 9 真实 Socket.IO E2E | PASS，17/17 |
| Realtime + buy-in 回归 | PASS，37/37（增加握手场景前的聚焦轮次） |
| 全部 API integration | PASS，31/31 |
| 根级 `pnpm test` | PASS，contracts 30、web 55、settlement 14、API 240，共 339/339 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；PWA generateSW，21 个 precache 项 |
| `git diff --check` | PASS |
| 本任务内容与已跟踪文件秘密扫描 | PASS，0 命中 |

## 文件清单

- `apps/api/src/realtime/`：Gateway、会话适配器、presence 引用计数、提交后事件发布器和全局 realtime module。
- `packages/contracts/src/realtime.ts`、`realtime.test.ts`：命令、ack、事件共享契约及 canonical/strict 测试。
- `apps/api/src/auth/session.service.ts`、`auth.service.ts`：原始令牌复用验证和会话失效通知。
- `apps/api/src/games/`：HTTP/Socket 快照接入真实 presence，生命周期提交后广播。
- `apps/api/src/buyins/buyins.service.ts`：购买/更正提交后广播与广播失败隔离。
- `apps/api/src/settings/settings.service.ts`：全局抽成版本广播。
- `apps/api/src/users/users.service.ts`：个人抽成事件与用户会话失效后的 socket 断开。
- `apps/api/test/realtime.e2e-spec.ts`：真实 Socket.IO、HTTP 和 MariaDB 端到端覆盖。

## Concerns

- Presence 是规格确认的单应用实例内存状态；如果未来横向扩展为多个应用实例，需要 Socket.IO Redis adapter 和共享 presence，不能直接沿用当前 Map。
- 广播是提交后的 best-effort 信号，不是持久事件队列；短暂广播故障依靠客户端重连/轮询并从数据库完整快照恢复，这是当前故障模型的有意设计。
- WebSocket 命令会验证闲置过期，但不会刷新浏览器 Cookie 的过期时间；Cookie 滑动续期仍由正常 HTTP 活动完成，避免出现数据库会话已延长但浏览器没有收到新的 Set-Cookie。
