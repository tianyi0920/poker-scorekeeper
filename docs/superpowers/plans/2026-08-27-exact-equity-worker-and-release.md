# Exact Equity Worker and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将独立和对局内胜率计算统一改为浏览器 Web Worker 中的精确穷举，完整处理取消、迟到结果和失败状态；随后对三项已批准改动做全量验证，提交、推送并发布 `v1.0.23`，但不部署生产。

**Architecture:** 保留纯同步 `calculateHoldemEquity` 作为 Worker 内核，但删除模拟分支；新增可测试的 Worker 协议、每实例异步客户端和 React Hook。每次新任务终止旧 Worker并用递增 `requestId` 拒绝迟到结果。对局内自动提交有效牌面，独立工具由按钮提交；二者不共享 Worker 单例、不调用 API、不持久化牌面。

**Tech Stack:** TypeScript, React 19, Vite 7 Web Workers, `@poker-apprentice/hand-evaluator` 4.3.0, Vitest 3, Testing Library, Playwright 1.55, GitHub Actions, Docker Buildx

**Spec:** `docs/superpowers/specs/2026-08-27-user-owned-games-compact-home-exact-equity-design.md`

## Global Constraints

- [ ] 公共牌仅允许 0、3、4、5 张，玩家 2 至 9 人，每人必须恰好两张且所有已知牌唯一。
- [ ] 四种街道全部调用 `equityHoldem` 精确穷举；业务代码不得导入或调用 `simulateHoldem`。
- [ ] 计算只在浏览器本地执行，不调用 API、不上传、不写 localStorage/IndexedDB。
- [ ] 每个已挂载计算器拥有独立 Worker；新请求终止同实例的旧 Worker，卸载时终止活动 Worker。
- [ ] 迟到响应按 `requestId` 丢弃；错误必须清空旧结果并显示明确错误，禁止静默回落模拟。
- [ ] 对局内自动计算，独立工具保留“计算胜率”按钮。
- [ ] 最终发布固定版本 `v1.0.23`、完整提交标签和 `latest`；不运行任何生产部署或生产验证命令。
- [ ] 先取得可重复的 RED，再实施和提交；发布前使用 verification-before-completion 技能复核证据。

## File and Interface Map

- `apps/web/src/features/games/holdem-equity.ts` — 纯计算内核，始终精确并返回样本数。
- `apps/web/src/features/games/holdem-equity-worker-protocol.ts` — Worker 请求、成功/失败响应与类型守卫。
- `apps/web/src/features/games/holdem-equity.worker.ts` — Worker 入口，调用纯计算内核并发回可克隆结果。
- `apps/web/src/features/games/holdem-equity-worker-client.ts` — 每实例 Worker 生命周期、请求 ID、取消和 dispose。
- `apps/web/src/features/games/useHoldemEquity.ts` — React 状态机：idle/loading/success/error。
- `apps/web/src/features/games/HoldemEquityTable.tsx` — 对局内自动计算和状态文案。
- `apps/web/src/features/tools/EquityCalculatorPage.tsx` — 按钮触发精确计算和失败/加载呈现。
- 对应 `*.test.ts(x)` — 纯计算、Worker、Hook 和两种 UI 的 RED/GREEN 证据。
- `tests/e2e/mobile-layout.spec.ts` — 真浏览器 Worker、响应性和移动端布局回归。
- `.github/workflows/publish-docker.yml` 与发布脚本 — 已存在，最终只触发和验证，不重写发布系统。

### Public interfaces

```ts
export interface HoldemEquityInput {
  players: Array<{ id: string; cards: HoldemCard[] }>;
  boardCards: HoldemCard[];
}

export interface HoldemEquityResult {
  mode: 'exact';
  samples: number;
  players: HoldemEquityPlayerResult[];
}

export interface HoldemEquityWorkerRequest {
  requestId: number;
  input: HoldemEquityInput;
}

export type HoldemEquityWorkerResponse =
  | { requestId: number; ok: true; result: HoldemEquityResult }
  | { requestId: number; ok: false; message: string };
```

The client surface should be minimal:

```ts
export interface HoldemEquityWorkerClient {
  calculate(input: HoldemEquityInput): Promise<HoldemEquityResult>;
  cancel(): void;
  dispose(): void;
}
```

---

### Task 1: Make every street exact in the pure calculation kernel

**Files:**

- Modify: `apps/web/src/features/games/holdem-equity.ts`
- Modify: `apps/web/src/features/games/holdem-equity.test.ts`

- [ ] **Step 1: Replace the simulation expectation with an exact pre-flop oracle**

Change the existing pre-flop test to require exhaustive samples for two known hands:

```ts
it('enumerates every legal five-card board before the flop', () => {
  const result = calculateHoldemEquity({
    players: [
      { id: 'aces', cards: ['As', 'Ah'] },
      { id: 'kings', cards: ['Kc', 'Kd'] }
    ],
    boardCards: []
  });

  expect(result.mode).toBe('exact');
  expect(result.samples).toBe(1_712_304);
  expect(result.players.reduce((sum, player) => sum + player.equityPercentage, 0))
    .toBeCloseTo(100, 5);
});
```

Keep exact flop/turn/river, tie splitting, zero-equity rounding and invalid-deal tests. Remove the `simulationSamples` test option from public types.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/holdem-equity.test.ts
```

Expected: FAIL because a zero-card board currently selects simulation and reports 10,000 samples.

- [ ] **Step 3: Remove the simulation branch**

Import only `equityHoldem` from the evaluator. Validate the input first, then always call exact enumeration. Keep existing percentage conversion and final-equity reconciliation. Return `mode: 'exact'` for compatibility with current renderers while narrowing the type to the literal.

- [ ] **Step 4: Prove exactness and bound synchronous kernel performance**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/holdem-equity.test.ts
```

Expected: PASS. Record elapsed time as diagnostic evidence, but do not introduce a time-based unit-test assertion that would be flaky on slower hardware.

- [ ] **Step 5: Commit the exact kernel**

```powershell
git add apps/web/src/features/games/holdem-equity.ts apps/web/src/features/games/holdem-equity.test.ts
git commit -m "feat: calculate exact holdem equity on every street"
```

### Task 2: Build a fail-closed Worker protocol and per-instance client

**Files:**

- Create: `apps/web/src/features/games/holdem-equity-worker-protocol.ts`
- Create: `apps/web/src/features/games/holdem-equity.worker.ts`
- Create: `apps/web/src/features/games/holdem-equity-worker-client.ts`
- Create: `apps/web/src/features/games/holdem-equity-worker-client.test.ts`

- [ ] **Step 1: Write a controllable fake-Worker test harness**

Inject a Worker factory into `createHoldemEquityWorkerClient` for tests. Cover:

- valid success resolves the matching request;
- a second `calculate` terminates the first Worker and rejects/cancels the first promise;
- a late response from the old Worker cannot resolve or overwrite the second request;
- worker `error`, malformed response and `{ ok: false }` reject with a stable error;
- `dispose` terminates the active Worker and future calculation is rejected.

Use deterministic fake Workers; do not depend on jsdom implementing the browser Worker API.

- [ ] **Step 2: Run the client test and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/holdem-equity-worker-client.test.ts
```

Expected: FAIL because protocol/client modules do not exist.

- [ ] **Step 3: Implement request/response guards**

The protocol module must accept only finite positive integer `requestId`, exact result mode, finite nonnegative sample count and finite percentages. Convert thrown evaluator/validation errors to a generic worker failure message; do not serialize stacks or card data into telemetry.

- [ ] **Step 4: Implement the Worker entry**

Use the module-worker-compatible Vite entry:

```ts
self.onmessage = (event: MessageEvent<HoldemEquityWorkerRequest>) => {
  const { requestId, input } = event.data;
  try {
    self.postMessage({ requestId, ok: true, result: calculateHoldemEquity(input) });
  } catch {
    self.postMessage({ requestId, ok: false, message: '精确计算失败，请重试' });
  }
};
```

Validate the envelope before calculation and return a failure response where a usable request ID exists.

- [ ] **Step 5: Implement the client factory**

Production Worker creation must use:

```ts
new Worker(new URL('./holdem-equity.worker.ts', import.meta.url), { type: 'module' })
```

On every `calculate`, invalidate/terminate the previous Worker, increment the internal request ID, create a fresh Worker and install one-shot message/error handlers. Compare the response ID before resolving. `cancel` and `dispose` clear handlers and terminate exactly once.

- [ ] **Step 6: Run tests and Vite build**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/holdem-equity-worker-client.test.ts
pnpm --filter @poker/web build
```

Expected: PASS and Vite emits a Worker chunk without Node/DOM type errors.

- [ ] **Step 7: Commit the Worker boundary**

```powershell
git add apps/web/src/features/games/holdem-equity-worker-protocol.ts apps/web/src/features/games/holdem-equity.worker.ts apps/web/src/features/games/holdem-equity-worker-client.ts apps/web/src/features/games/holdem-equity-worker-client.test.ts
git commit -m "feat: run exact equity in isolated workers"
```

### Task 3: Add the shared React async state machine

**Files:**

- Create: `apps/web/src/features/games/useHoldemEquity.ts`
- Create: `apps/web/src/features/games/useHoldemEquity.test.tsx`

- [ ] **Step 1: Write failing Hook tests**

Design the Hook around a submitted `HoldemEquityInput | null` and inject a client factory in tests. Cover:

- `null` stays idle and cancels an active request;
- a valid input immediately clears the old result and becomes loading;
- success becomes `{ status: 'success', result }`;
- rejection becomes `{ status: 'error', result: null }`;
- input A followed by B cannot publish A's late result;
- unmount calls `dispose` and does not update React state afterward.

- [ ] **Step 2: Run the Hook test and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/useHoldemEquity.test.tsx
```

Expected: FAIL because the Hook is absent.

- [ ] **Step 3: Implement the Hook with explicit states**

Use a discriminated union:

```ts
type HoldemEquityState =
  | { status: 'idle'; result: null }
  | { status: 'loading'; result: null }
  | { status: 'success'; result: HoldemEquityResult }
  | { status: 'error'; result: null };
```

Create one client per mounted Hook with `useRef`, call `calculate` in an effect keyed by the submitted input, and dispose on unmount. Use an effect-local active flag in addition to client request IDs so React teardown cannot publish stale state.

- [ ] **Step 4: Run the Hook test**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/useHoldemEquity.test.tsx
```

Expected: PASS without `act` or unmounted-update warnings.

- [ ] **Step 5: Commit the shared Hook**

```powershell
git add apps/web/src/features/games/useHoldemEquity.ts apps/web/src/features/games/useHoldemEquity.test.tsx
git commit -m "feat: add cancellable equity calculation hook"
```

### Task 4: Move the in-game table to asynchronous exact calculation

**Files:**

- Modify: `apps/web/src/features/games/HoldemEquityTable.tsx`
- Modify: `apps/web/src/features/games/HoldemEquityTable.test.tsx`
- Modify only for styles if required: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add failing UI state tests**

Inject/fake the Hook client through the module boundary and prove:

- fewer than two complete hands keeps the instructional summary;
- two complete hands immediately display “正在精确计算…” with no old percentages;
- success displays percentages and `精确穷举 · 共计算 1,712,304 种牌面`;
- quick card changes accept only the latest result;
- failure keeps selected cards, removes old percentages and shows `精确计算失败，请重试`;
- changing/clearing cards starts a new calculation or returns to idle.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/HoldemEquityTable.test.tsx
```

Expected: FAIL because calculation currently blocks inside `useMemo` and has no loading/error state.

- [ ] **Step 3: Replace synchronous render-time work**

Memoize an input only when at least two players have complete hands and the board count is valid, then pass it to `useHoldemEquity`. Build percentages only from a success result. Render:

- idle: existing street and selection prompt;
- loading: `正在精确计算…`;
- success: `精确穷举 · 共计算 ${formattedSamples} 种牌面` plus participant count;
- error: `精确计算失败，请重试`.

Do not import `calculateHoldemEquity` into the component after this change.

- [ ] **Step 4: Re-run the table tests**

```powershell
pnpm --filter @poker/web exec vitest run src/features/games/HoldemEquityTable.test.tsx src/features/games/RoundTable.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the in-game integration**

```powershell
git add apps/web/src/features/games/HoldemEquityTable.tsx apps/web/src/features/games/HoldemEquityTable.test.tsx apps/web/src/styles/global.css
git commit -m "feat: calculate table equity without blocking"
```

### Task 5: Move the standalone calculator to the same Worker path

**Files:**

- Modify: `apps/web/src/features/tools/EquityCalculatorPage.tsx`
- Modify: `apps/web/src/features/tools/EquityCalculatorPage.test.tsx`
- Modify only for styles if required: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add failing manual-submit tests**

Cover:

- choosing cards alone does not calculate until the button is clicked;
- clicking sets loading text and disables duplicate submission while that request is active;
- success shows exact sample count and player equity/win/tie values;
- editing any selected card invalidates the submitted result;
- failure keeps cards selected, clears old results and shows the exact failure message;
- reset cancels current work and returns to the two-player empty state.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/tools/EquityCalculatorPage.test.tsx
```

Expected: FAIL because the button currently executes the synchronous kernel and has no loading/error state.

- [ ] **Step 3: Separate editing input from submitted input**

Keep current card-selection state, add `submittedInput: HoldemEquityInput | null`, and pass only that snapshot to `useHoldemEquity`. Any player/board edit, add/remove, clear or reset sets `submittedInput` to `null`. The button copies current complete hands and board into a new submitted object.

Render the same messages as the in-game table:

- loading: `正在精确计算…`;
- success: `精确穷举 · 共计算 X 种牌面`;
- failure: `精确计算失败，请重试`.

Keep “仅在本机计算，不上传牌面”. Remove all simulated/精算 conditional wording.

- [ ] **Step 4: Re-run standalone tests**

```powershell
pnpm --filter @poker/web exec vitest run src/features/tools/EquityCalculatorPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the standalone integration**

```powershell
git add apps/web/src/features/tools/EquityCalculatorPage.tsx apps/web/src/features/tools/EquityCalculatorPage.test.tsx apps/web/src/styles/global.css
git commit -m "feat: use exact worker in equity calculator"
```

### Task 6: Prove real-browser responsiveness and no simulation fallback

**Files:**

- Modify: `tests/e2e/mobile-layout.spec.ts`
- Modify only if a dedicated scenario is clearer: `tests/e2e/game-flow.spec.ts`

- [ ] **Step 1: Extend the browser tests**

In the standalone calculator and in-game equity scenarios:

- select two complete hands with zero, three, four and five public cards across cases;
- assert loading appears before success where observable;
- assert success contains `精确穷举` and a nonzero formatted sample count;
- assert no visible text matches `模拟`;
- while the zero-board Worker is busy, click an unrelated safe control (for example a page tab or card-picker close/reset control) and prove it responds before the calculation result;
- rapidly replace one player's cards and prove the displayed percentages correspond only to the final selection;
- repeat geometry checks at Chromium 320×568, Chromium 360×800 and WebKit 430×932.

Do not assert a fixed wall-clock maximum; assert main-thread responsiveness and eventual completion with a generous test timeout.

- [ ] **Step 2: Run focused Chromium and WebKit tests**

```powershell
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=chromium-320x568 --grep "equity"
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=chromium-360x800 --grep "equity"
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=webkit-430x932 --grep "equity"
```

Expected: PASS, with no horizontal overflow or frozen interaction.

- [ ] **Step 3: Prove the source has no simulation path**

```powershell
rg -n "simulateHoldem|simulationSamples|mode === 'simulated'|模拟" apps/web/src
```

Expected: no business-code match. Test descriptions may mention the prohibited fallback only when asserting absence; prefer removing stale terminology entirely.

- [ ] **Step 4: Commit browser proof**

```powershell
git add tests/e2e/mobile-layout.spec.ts tests/e2e/game-flow.spec.ts
git commit -m "test: verify exact equity worker in browsers"
```

### Task 7: Run release-level verification for all three plans

**Files:**

- No expected source edits; fix only defects exposed by verification and commit them separately.

- [ ] **Step 1: Invoke the verification-before-completion skill**

Re-read its current `SKILL.md` and follow its evidence requirements. Do not reuse earlier green output after any source change.

- [ ] **Step 2: Confirm the working tree and intended diff**

```powershell
git status --short
git diff --check
git log --oneline v1.0.22..HEAD
```

Expected: only approved feature/test/docs commits, no generated secrets, screenshots or unrelated files.

- [ ] **Step 3: Run static and unit/API gates**

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 4: Run the full browser suite**

```powershell
pnpm exec playwright test
```

Expected: all configured Chromium/WebKit tests pass. Record exact project/test counts.

- [ ] **Step 5: Run the isolated container release drill**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1
```

Expected: `release verification passed`, including build, migration, health, restart, backup and restore checks. If Docker is unavailable, treat it as a release blocker; do not skip the gate and claim publish-ready.

- [ ] **Step 6: Commit any verification-only fixes and rerun affected gates**

Every fix gets a focused regression test and a small commit. After the last fix, rerun Steps 2–5 from fresh state.

### Task 8: Push and publish immutable Docker version v1.0.23

**Files:**

- No source edits expected.

- [ ] **Step 1: Verify release preconditions immediately before the external write**

```powershell
git status --short
git branch --show-current
git ls-remote --tags origin refs/tags/v1.0.23
```

Expected: clean tree, intended branch, and no remote `v1.0.23` tag. Confirm the user-requested release authority from this task; do not ask again unless the target/version changed.

- [ ] **Step 2: Push the completed branch/commit**

```powershell
git push origin HEAD
```

Expected: origin contains the exact verified commit.

- [ ] **Step 3: Create and push the immutable release tag**

```powershell
git tag -a v1.0.23 -m "Release v1.0.23"
git push origin v1.0.23
```

Do not move or overwrite the tag if the workflow later fails.

- [ ] **Step 4: Monitor the publish workflow to completion**

Use the available GitHub/API/browser mechanism to follow `.github/workflows/publish-docker.yml`. Wait through build, publish, remote verification and `latest` promotion. A successful tag push alone is not publication proof.

- [ ] **Step 5: Verify remote identity and platforms**

Resolve the release commit SHA and inspect:

```text
docker.io/tianyi920/poker-scorekeeper:1.0.23
docker.io/tianyi920/poker-scorekeeper:sha-<full-commit-sha>
docker.io/tianyi920/poker-scorekeeper:latest
```

Use the repository's existing Docker publish contract/Buildx inspection approach. Confirm fixed, commit and latest references resolve to the same verified digest and declared platforms, and the image revision label equals the release commit.

- [ ] **Step 6: Stop at publication**

Report the commit, tag, image references, digest, platforms and verification counts. Do not SSH to production, edit production environment files, pull/restart Compose, or run `scripts/verify-production.mjs`; deployment belongs to the user.

## Completion Evidence

- [ ] RED evidence exists for exact pre-flop, Worker cancellation, Hook stale-result suppression and both UI loading/error states.
- [ ] `rg` proves no `simulateHoldem` or simulation fallback remains in application code.
- [ ] Full lint, typecheck, test, build, Playwright and release-drill outputs are fresh after the last code change.
- [ ] `v1.0.23`, `sha-<full-sha>` and `latest` share the verified digest/platform set.
- [ ] No production deployment action was performed.
