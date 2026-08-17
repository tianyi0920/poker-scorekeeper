# Task 15 实施报告：实时圆桌、购买筹码与购买时间线

## 状态

完成。已交付移动端优先的实时牌桌页面：支持最多 12 人圆桌、自身座位固定在底部、观战区、服务端时间基准计时、购买/更正、购买时间线、Socket.IO 断线重连与 HTTP 降级同步，以及管理员结束对局的二次确认入口。实现直接使用 Task 8/9 的 HTTP 与 realtime 共享 contracts，没有以假字段绕过后端契约。

实施分支：`codex/poker-frontend-3`。本任务使用单一实现提交，提交号见 Git 历史。

## 实现内容

- `/games/:id` 由占位页升级为真实 `GamePage`，初次通过 HTTP 获取完整快照，然后连接同源 Socket.IO；所有 Socket payload 和 ack 均经 `@poker/contracts` 的 Zod schema 校验。
- 重连时使用内存中最新快照的 `version` 发送 `game.join { gameId, knownVersion }`。实时连接断开 5 秒后立即读取一次 HTTP 快照，之后每 10 秒轮询；重连成功即停止轮询。页面清晰展示连接/降级状态。
- 真实椭圆牌桌支持 1、8、12 人布局；按 `seatNo` 排序并旋转座位，使当前用户固定在底部。每个座位显示头像、昵称、有效手数和负买入金额；9–12 人自动进入紧凑布局。
- 牌桌中央显示基于 `startedAt`、`stoppedAt`、`serverNow` 计算的计时器、每手金额和全桌总买入。总买入使用 `BigInt`，避免金额精度损失。
- 观战区展示实时 spectators；对战区与购买记录使用移动端双 Tab，时间线区分 `BUY` 与 `ADJUST`，显示玩家、操作人、时间、手数变化和有符号金额。
- 购买筹码采用底部 sheet，提供 1/2/3/5/10 手快捷项及 1–99 手输入；更正允许 0–99 手，0 会提交追加冲正记录而非删除历史。
- 只有当前用户最新的逻辑购买链显示更正入口，且仅在 `ACTIVE` 状态开放。12 人满桌时未入座观战者无法再购买；`SETTLING` 状态隐藏全部购买与更正写入口。
- 每次购买/更正生成 UUID 幂等键。若网络结果未知，界面锁定原请求内容且只能用完全相同的 key 重试；收到确定的 API 错误后才清除 pending key。
- `unsafe` 写按钮沿用全局离线策略：浏览器离线时禁用。真实后端购买冲突码已映射为本地安全提示，包括满桌、非最后购买、金额溢出和幂等冲突。
- `ADMIN` 与 `SUPER_ADMIN` 可在 ACTIVE 对局点击“结束对局”，经过二次确认后调用真实 `begin-settlement` 接口；普通用户不可见，成功后立即应用 SETTLING 快照并关闭写入口。
- Vite 与 Vitest 显式把 `@poker/contracts` 指向 monorepo 源码，使独立 Web 测试和生产构建使用同一运行时 schema，不修改 contracts 包导出或伪造前端 DTO。

## TDD：RED / GREEN

- 首轮组件 RED：新增 `RoundTable`、`BuyInSheet`、`GamePage` 测试时，三个 suite 因实现不存在而失败，既有 Web 55 项保持通过。
- 功能 GREEN：完成圆桌、购买、更正、时间线、实时连接和轮询后，三个目标测试文件 13/13 通过。
- 浏览器检查发现 360 px 宽下底部操作 dock 会遮住自身金额；新增回归断言先失败（自身座位 top 为 88%/84%），将圆桌纵向半径调整为 30% 后，自身 top 为 80%，回归通过。
- 管理员结束对局测试先因按钮缺失而失败；实现角色门禁、二次确认和状态切换后通过。
- 新增 4 个真实买入错误码断言时均从未知码降级为 `HTTP_ERROR`，按预期 RED；加入受控本地映射后聚焦测试 18/18 通过。
- 最终 Web 全量测试 17 个文件、74/74 通过。

## 移动端浏览器验证

使用生产构建和同源契约形状 fixture，在真实浏览器明确设置 360 × 800 viewport 检查：

| 场景 | 结果 |
|---|---|
| 12 人圆桌 | PASS；全部座位可见，自身完整信息位于底部且不被 dock 遮挡 |
| 购买 sheet | PASS；快捷项、手输、金额和主操作清晰，底部弹层无横向溢出 |
| 购买时间线 | PASS；BUY/ADJUST、操作人、手数变化、金额与更正入口可辨识 |
| Socket 断开 5 秒 | PASS；出现“每 10 秒定期同步”降级 banner |
| 版面宽度 | PASS；`innerWidth=360`，内容 `scrollWidth=clientWidth=345` |
| 触控尺寸 | PASS；可见 button/link/input 均不小于 44 px |
| Console | PASS；error 0，warn 0 |

临时 fixture 在验证后已删除，浏览器 viewport 已复原且测试页签已关闭。

## 验证

| 验证 | 结果 |
|---|---|
| Web tests | PASS，17 files / 74 tests |
| Web lint | PASS |
| Web typecheck | PASS |
| Contracts tests | PASS，4 files / 30 tests |
| Contracts typecheck | PASS |
| Web production build | PASS，242 modules；JS 427.88 kB，CSS 18.60 kB |
| PWA | PASS，generateSW；21 个 precache 项，521.01 KiB |
| `git diff --check` | PASS |
| 本任务文件秘密值扫描 | PASS，0 命中 |
| TODO/FIXME/临时 fixture/console marker 扫描 | PASS，0 命中 |

## 文件清单

- `apps/web/src/features/games/GamePage.tsx`：快照加载、Socket 重连、HTTP fallback、角色/状态控制和牌桌页面编排。
- `apps/web/src/features/games/RoundTable.tsx`、`Seat.tsx`、`GameTimer.tsx`、`SpectatorBar.tsx`：圆桌、座位、计时与观战展示。
- `apps/web/src/features/games/PurchaseTimeline.tsx`：购买/更正时间线与最后逻辑购买入口。
- `apps/web/src/features/buyins/BuyInSheet.tsx`、`AdjustBuyInDialog.tsx`：购买与更正交互、输入边界、幂等重试。
- `apps/web/src/api/game-socket.ts`、`resources.ts`、`http-client.ts`：同源 Socket、真实 API 路由与稳定错误码。
- `apps/web/src/styles/global.css`：午夜金移动端圆桌、时间线、连接 banner 与底部 sheet 视觉。
- `apps/web/src/features/games/*.test.tsx`、`apps/web/src/features/buyins/BuyInSheet.test.tsx`、`apps/web/src/api/http-client.test.ts`：行为、权限、重连、幂等与布局回归。

## Concerns

- 当前 realtime schema 与 Task 9 已提交 contracts 一致；若 Task 9 后续修复收紧事件结构，集成时应以共享 contracts 为唯一来源吸收该修复，并重跑本报告全部 Web/浏览器矩阵。
- HTTP fallback 是连接断开后的恢复保障，不提供跨多实例共享 presence；多实例部署边界仍由 Task 9 的单实例架构约束决定。
- 移动端浏览器验证使用契约形状 fixture，不替代后续真实 API + MariaDB 的集成验收；本任务没有访问或修改测试/生产数据库。
