# Task 15 实施报告：实时圆桌、购买筹码与购买时间线

## 状态

完成。已交付移动端优先的实时牌桌页面：支持最多 12 人圆桌、自身座位固定在底部、观战区、服务端时间基准计时、购买/更正、购买时间线、Socket.IO 断线重连与 HTTP 降级同步，以及管理员结束对局的二次确认入口。实现直接使用 Task 8/9 的 HTTP 与 realtime 共享 contracts，没有以假字段绕过后端契约。

实施分支：`codex/poker-frontend-3`。初始实现和独立审查修复均使用独立提交，提交号见 Git 历史。

## 实现内容

- `/games/:id` 由占位页升级为真实 `GamePage`，初次通过 HTTP 获取完整快照，然后连接同源 Socket.IO；所有 Socket payload 和 ack 均经 `@poker/contracts` 的 Zod schema 校验。
- transport connected 与 room synchronized 是独立状态。重连时使用内存中最新快照的 `version` 发送 `game.join { gameId, knownVersion }`；负 ACK、非法 ACK 与 3 秒无 ACK 均保持未同步并显示 banner，5 秒后启用立即 HTTP 快照和每 10 秒轮询，同时在 transport 可用时每 5 秒重试 join。成功 join 才停止 fallback，卸载会清理所有 timer/listener。
- 真实椭圆牌桌支持 1、8、12 人布局；按 `seatNo` 排序并旋转座位，使当前用户固定在底部。每个座位显示头像、昵称、有效手数和负买入金额；9–12 人使用经过 360 px 实测的 12 槽紧凑周界，内容矩形互不相交。
- 牌桌中央显示基于 `startedAt`、`stoppedAt`、`serverNow` 计算的计时器、每手金额和全桌总买入。总买入使用 `BigInt`，避免金额精度损失。
- 观战区展示实时 spectators；对战区与购买记录使用移动端双 Tab，包含完整 `aria-controls`/`aria-labelledby`、roving tabindex 及 Left/Right/Home/End 键盘操作。时间线区分 `BUY` 与 `ADJUST`，显示玩家、操作人、时间、手数变化和有符号金额。
- 购买筹码采用底部 sheet，提供 1/2/3/5/10 手快捷项及 1–99 手输入；更正允许 0–99 手，0 会提交追加冲正记录而非删除历史。
- 只有当前用户最新的逻辑购买链显示更正入口，且仅在 `ACTIVE` 状态开放。12 人满桌时未入座观战者无法再购买；ACTIVE 实时变为 `SETTLING` 会立即关闭已经打开的购买/更正弹层，组件提交函数也用最新 `canWrite` 二次拒绝，不能通过直接 form submit 绕过。
- 每次购买/更正生成 UUID 幂等键。TypeError、5xx、`HTTP_ERROR`、`INTERNAL_ERROR` 等结果未知失败会锁定原请求内容并强制使用完全相同的 key 连续重试；只有成功或明确未执行的受控 4xx 才释放 key，下一次操作才生成新 key。
- `unsafe` 写按钮沿用全局离线策略：浏览器离线时禁用。真实后端购买冲突码已映射为本地安全提示，包括满桌、非最后购买、金额溢出和幂等冲突。
- `ADMIN` 与 `SUPER_ADMIN` 可在 ACTIVE 对局点击“结束对局”，经过二次确认后调用真实 `begin-settlement` 接口；普通用户不可见，成功后立即应用 SETTLING 快照并关闭写入口。
- Vite 与 Vitest 显式把 `@poker/contracts` 指向 monorepo 源码，使独立 Web 测试和生产构建使用同一运行时 schema，不修改 contracts 包导出或伪造前端 DTO。
- game snapshot/update、presence、rake settings、player rake、server error 和 join ack 均使用 Task 9 共享 schema 解析；非法事件不触发刷新或断线。切换 `/games/:id` 时会先清空快照/version ref，并隔离旧路由的迟到 HTTP 响应。

## TDD：RED / GREEN

- 首轮组件 RED：新增 `RoundTable`、`BuyInSheet`、`GamePage` 测试时，三个 suite 因实现不存在而失败，既有 Web 55 项保持通过。
- 功能 GREEN：完成圆桌、购买、更正、时间线、实时连接和轮询后，三个目标测试文件 13/13 通过。
- 浏览器检查发现 360 px 宽下底部操作 dock 会遮住自身金额；新增回归断言先失败（自身座位 top 为 88%/84%），将圆桌纵向半径调整为 30% 后，自身 top 为 80%，回归通过。
- 管理员结束对局测试先因按钮缺失而失败；实现角色门禁、二次确认和状态切换后通过。
- 新增 4 个真实买入错误码断言时均从未知码降级为 `HTTP_ERROR`，按预期 RED；加入受控本地映射后聚焦测试 18/18 通过。
- 审查修复 RED：购买与更正对 502/503/504、`HTTP_ERROR`、`INTERNAL_ERROR` 都错误释放幂等 key；两条连续重试测试失败。修复后相同 key 连续三次保持一致，成功后才生成新 key；受控 409 会释放旧 key。
- 审查修复 RED：transport 一连接就隐藏 banner，导致负 ACK、非法 ACK 和无 ACK 都被误报为已同步；严格事件解析测试也捕获了非法 settings/player-rake/server.error payload 的副作用。状态拆分、超时、重试和共享 schema 接入后，GamePage 聚焦 13/13。
- 审查修复 RED：ACTIVE→SETTLING 后 Buy/Adjust 弹层仍保留；路由从 version 9 的 game-1 切到 version 1 的 game-2 会被旧 ref 拒绝；Tab 缺少关联和键盘行为。写保护、路由隔离和 ARIA 修复后，buy-in + GamePage 聚焦 23/23。
- 12 人布局真实浏览器 RED：360×800 下 12 个 54×70.51 px 座位内容矩形有 8 对相交；自动几何回归得到完全相同的 8 对。调整紧凑周界后，两侧、顶部和底部间距满足完整内容矩形，浏览器复测 `overlaps=[]`。
- 最终 Web 全量测试 17 个文件、88/88 通过。

## 移动端浏览器验证

使用生产构建和同源契约形状 fixture，在真实浏览器明确设置 360 × 800 viewport 检查：

| 场景 | 结果 |
|---|---|
| 12 人圆桌 | PASS；12 个内容矩形相交数从 8 对降为 0，自身完整信息位于底部且不被 dock 遮挡 |
| 购买 sheet | PASS；快捷项、手输、金额和主操作清晰，底部弹层无横向溢出 |
| 购买时间线 | PASS；BUY/ADJUST、操作人、手数变化、金额与更正入口可辨识 |
| Socket 断开 5 秒 | PASS；出现“每 10 秒定期同步”降级 banner |
| 版面宽度 | PASS；`innerWidth=360`，内容 `scrollWidth=clientWidth=360` |
| 触控尺寸 | PASS；可见 button/link/input 均不小于 44 px |
| Console | PASS；error 0，warn 0 |

临时 fixture 在验证后已删除，浏览器 viewport 已复原且测试页签已关闭。

## 验证

| 验证 | 结果 |
|---|---|
| Web tests | PASS，17 files / 88 tests |
| Web lint | PASS |
| Web typecheck | PASS |
| Contracts tests | PASS，4 files / 30 tests |
| Contracts typecheck | PASS |
| Web production build | PASS，242 modules；JS 430.30 kB，CSS 18.60 kB |
| PWA | PASS，generateSW；21 个 precache 项，523.38 KiB |
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
