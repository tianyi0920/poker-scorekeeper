# Compact Current Game Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将首页进行中对局卡片改成已确认的 A「紧凑分层」方案，删除多余进入提示并把移动端单卡高度压到约 150px，同时保持整卡可点击和信息可读。

**Architecture:** 保持 `CurrentGameCard` 是单一 `<Link>`，只精简其内部三层内容和 CSS 尺寸；不改变接口、数据模型或导航方式。用组件测试锁定语义，用三个移动视口锁定无横向溢出、无遮挡和可点击区域。

**Tech Stack:** React 19, TypeScript, CSS, Testing Library, Vitest 3, Playwright 1.55

**Spec:** `docs/superpowers/specs/2026-08-27-user-owned-games-compact-home-exact-equity-design.md`

## Global Constraints

- [ ] 整张卡片继续导航到 `/games/:id`，保留明确的 accessible name、键盘焦点和触摸反馈。
- [ ] 只删除“点击整张卡片进入”提示，不删除状态、名称、花色、玩家、每手、人数或总买入。
- [ ] 最多展示 5 个头像，额外人数继续显示 `+N`，昵称过长必须截断而不是撑破卡片。
- [ ] 视觉继续沿用深色、金色、绿色；不重做首页标签或历史战绩。
- [ ] 320px 宽度不得横向滚动；交互目标不小于现有可用尺寸。
- [ ] 先证明旧卡片不满足约束，再实现最小 JSX/CSS 变更。

## File and Interface Map

- `apps/web/src/features/home/CurrentGameCard.tsx` — 三层紧凑结构，移除底部提示。
- `apps/web/src/features/home/CurrentGameCard.test.tsx` — 新增专注的卡片语义与数据测试。
- `apps/web/src/features/home/HomePage.test.tsx` — 保留页面级加载、列表与创建入口覆盖。
- `apps/web/src/styles/global.css` — 卡片高度、间距、头像、昵称截断和数据块尺寸。
- `tests/e2e/mobile-layout.spec.ts` — 320×568、360×800、WebKit 430×932 几何回归。

---

### Task 1: Lock the compact card semantics with a focused component test

**Files:**

- Create: `apps/web/src/features/home/CurrentGameCard.test.tsx`
- Modify: `apps/web/src/features/home/HomePage.test.tsx`

- [ ] **Step 1: Write the failing card tests**

Render `CurrentGameCard` inside `MemoryRouter` with six players. Assert:

```ts
expect(screen.getByRole('link', { name: '进入对局：8月25日早场' }))
  .toHaveAttribute('href', '/games/game-1');
expect(screen.queryByText(/点击整张卡片进入/)).not.toBeInTheDocument();
expect(screen.getByText('+1')).toBeInTheDocument();
expect(screen.getByText('¥12300')).toBeInTheDocument();
```

Also retain a zero-player case for “等待玩家入座” and a SETTLING case for “结算中”.

- [ ] **Step 2: Run the focused tests and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/home/CurrentGameCard.test.tsx src/features/home/HomePage.test.tsx
```

Expected: FAIL because the old footer hint is still present.

- [ ] **Step 3: Remove only the redundant footer markup**

Delete `.current-game-enter` from `CurrentGameCard.tsx`. Preserve the outer `<Link>`, route encoding, `aria-label`, status label, decorative spade, players and three statistics.

- [ ] **Step 4: Re-run the component tests**

```powershell
pnpm --filter @poker/web exec vitest run src/features/home/CurrentGameCard.test.tsx src/features/home/HomePage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the semantic cleanup**

```powershell
git add apps/web/src/features/home/CurrentGameCard.tsx apps/web/src/features/home/CurrentGameCard.test.tsx apps/web/src/features/home/HomePage.test.tsx
git commit -m "refactor: remove redundant game card prompt"
```

### Task 2: Implement the A compact layered geometry

**Files:**

- Modify: `apps/web/src/styles/global.css`
- Modify only if structure requires it: `apps/web/src/features/home/CurrentGameCard.tsx`
- Modify: `tests/e2e/mobile-layout.spec.ts`

- [ ] **Step 1: Add a failing browser geometry assertion**

Extend the existing mobile homepage setup and, for the current-game link, assert:

```ts
const card = page.getByRole('link', { name: /进入对局/ }).first();
const box = await card.boundingBox();
expect(box).not.toBeNull();
expect(box!.height).toBeLessThanOrEqual(165);
expect(await page.evaluate(() => document.documentElement.scrollWidth))
  .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
```

Use 165px as the regression ceiling so font rendering can vary while the target remains roughly 150px. Add an assertion that the three stats are visible and do not overlap the player row.

- [ ] **Step 2: Run the focused Chromium test and confirm RED**

```powershell
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=chromium-320x568 --grep "current game card"
```

Expected: FAIL because the old card includes a fourth footer row and exceeds the ceiling.

- [ ] **Step 3: Apply compact CSS tokens**

Adjust the existing selectors rather than introducing a parallel card system:

- `.current-game-card`: reduce vertical padding and row gaps; use a three-row grid/stack.
- `.card-heading`: keep status/name/spade on row 1; constrain the name with `min-width: 0`, ellipsis and one line.
- `.current-game-players`: compact row 2; reduce avatar diameter/negative stack overlap without hiding `+N`.
- `.current-game-player-names`: one-line ellipsis.
- `.current-game-card .stat-grid`: compact row 3 into three equal columns with smaller internal padding and line-height.
- remove unused `.current-game-enter` rules.
- keep `:hover` and `:focus-visible` behavior on the outer link.

Prefer responsive CSS (`clamp`, grid minmax, `min-width: 0`) over viewport-specific absolute positioning. Do not set a fixed height that clips larger system fonts; use a minimum/maximum regression target through content and spacing.

- [ ] **Step 4: Verify all approved viewports**

Run:

```powershell
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=chromium-320x568
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=chromium-360x800
pnpm exec playwright test tests/e2e/mobile-layout.spec.ts --project=webkit-430x932
```

Within the test, exercise at least Chromium 320×568, Chromium 360×800 and WebKit 430×932. Expected: no horizontal overflow, no overlap, card height at or below 165px, and the outer link remains clickable.

- [ ] **Step 5: Run focused unit, type and lint checks**

```powershell
pnpm --filter @poker/web exec vitest run src/features/home/CurrentGameCard.test.tsx src/features/home/HomePage.test.tsx
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web lint
```

Expected: PASS.

- [ ] **Step 6: Commit the compact visual implementation**

```powershell
git add apps/web/src/features/home/CurrentGameCard.tsx apps/web/src/styles/global.css tests/e2e/mobile-layout.spec.ts
git commit -m "feat: compact current game cards"
```

## Completion Evidence

- [ ] Save the pre-change failing height assertion as RED evidence.
- [ ] Record final card bounding boxes at 320, 360 and 430 CSS-pixel widths.
- [ ] Confirm `rg -n "点击整张卡片进入|current-game-enter" apps/web/src` returns no application match.
- [ ] Confirm keyboard activation and the same `/games/:id` target still work.
- [ ] Do not call this plan complete from a screenshot alone; both component and geometry tests must pass.
