# Task 1a 报告：重建部署指南安全校验器

基线：`9e88c10`

## 实现

- 将 `deployment-artifacts.spec.ts` 中的 inline 部署指南 helper 移至 `apps/api/test/support/deployment-guide-validator.ts`，由集成测试继续调用同一个纯 validator 校验 Extreme Space、Synology 和 production checklist 三份真实指南。
- URL 扫描不区分协议大小写，逐个解析 HTTPS/WSS/HTTP/WS token；只允许 `127.0.0.1:3000`、`localhost:3000`、`[::1]:3000` 三种回环 HTTP origin，拒绝所有其它 HTTP 和所有 WS。扫描器保留 IPv6 方括号，识别 Markdown 强调中的 URL，并处理中文/ASCII 尾标点；说明性裸 `https://` 不被误当成完整 URL。
- 环境赋值使用小型字符解析器覆盖 dotenv、`export`、Markdown bullet、`docker -e`、单双引号和整条引号语法。等号周围只允许水平空白，空值不能跨行借用下一行。`PORT` 只能为 `80`；`PUBLIC_ORIGIN` 和 `WS_ALLOWED_ORIGINS` 的每一项必须是 raw 纯 HTTPS origin。
- raw origin 在进入 `URL` 前拒绝正斜杠/反斜杠路径、空或非空查询/片段、dot segment、空端口；随后再拒绝凭据、空 hostname 和 opaque origin，避免 URL normalization 掩盖原始输入。
- `ports:` 块按缩进建立可靠边界，再使用仓库已有的 `yaml@2.8.1` 解析 YAML sequence。short/long/flow/quoted mapping 逐项校验，long 字段顺序无关，且每一项都必须精确为 host `127.0.0.1`、published `3000`、target `80`；正文 short token 也逐个扫描。
- 未修改三份部署指南、线上配置、Docker、DNS、代理或 secret，也未新增依赖。

## TDD 记录

1. 初始 RED：以无行为接口运行专门 spec，70 例中 46 个负例全部以“未抛错”失败，24 个正例通过；失败来自缺少校验行为，而非导入或测试语法错误。
2. 初始 GREEN：实现结构化 validator 后 70/70。过程中 IPv6 正例先暴露尾标点清理误删 `]`，修复为只删除不配对的 Markdown 右方括号。
3. 真实指南集成先 RED：Synology 对说明性裸 `https://` 的文字说明被误当成 URL；补直接回归后仅忽略没有 authority 的说明性 scheme，空 origin 仍由环境赋值解析器拒绝。
4. 自审 RED：`PUBLIC_ORIGIN=` 和 `WS_ALLOWED_ORIGINS=` 可跨行借用下一行 HTTPS 文本，2 例按预期失败；将赋值空白从 `\s*` 收紧到水平空白后转 GREEN。
5. raw normalization RED：反斜杠路径与空端口各 1 例按预期失败；在 raw authority 层拒绝后转 GREEN。最终专门 spec 为 75/75。

## 验证

- validator + deployment artifacts：103/103（validator 75/75；真实指南集成及其它部署产物 28/28）。
- Docker healthcheck：2/2。
- release helper：Task 18 为 5/5，Task 19 为 2/2；仅测试进程设置 `PSExecutionPolicyPreference=Bypass`，未修改系统执行策略。
- application security + WebSocket origin：10/10。
- API ESLint：通过。
- API typecheck：通过。Prisma generate 仅使用非秘密 loopback 占位 `DATABASE_URL`，未连接数据库。
- 新 validator/spec Prettier check：通过。
- `git diff --check`：通过。

## 顾虑

- 这是部署文档和片段的静态安全契约，不替代真实 OpenResty TLS/Upgrade、浏览器 101/CSP 或手机公网 HTTPS/WSS 验收。
- YAML 结构化解析聚焦 Markdown 中明确的 `ports:` 块；正文另外扫描 short mapping。其它与端口发布无关的任意 YAML 不在此 validator 的职责内。
