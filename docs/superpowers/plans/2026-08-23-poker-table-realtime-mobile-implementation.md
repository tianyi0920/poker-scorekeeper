# Poker Table, Realtime, and Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live table compact and information-first on mobile, hide global navigation during a game, handle iPhone safe areas, and restore the production WebSocket path so the fallback warning only appears after an actual connection failure.

**Architecture:** Keep Socket.IO with the existing 10-second polling fallback, but make the public origin consistently HTTPS so CSP and origin policy derive `wss://pk.tianyi.wiki`. Treat the game route as a focused workspace in `AppShell`; let `RoundTable` choose a density from occupied seats, and move key totals into a compact summary strip above the table.

**Tech Stack:** React 19, React Router 7, Socket.IO Client 4, NestJS 11, Socket.IO 4, Vitest, Testing Library, Playwright, CSS env safe-area variables, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-22-poker-scorekeeper-ux-hard-delete-design.md`

## Global Constraints

- HTTPS pages connect only to `wss://`; do not add mixed-content exceptions or relax CSP.
- Preserve the current 10-second polling fallback and data reconciliation behavior.
- Do not show a disconnection banner during the initial connection grace period.
- Keep all 12 seat positions usable and preserve buy-in controls and authorization.
- The empty/sparse table must be materially shorter than the current fixed ellipse.
- The focus layout must account for `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` without double padding.
- Bottom actions remain reachable at 320 CSS px width and with iPhone home-indicator insets.

---

## File Structure

- Modify `.env.extremespace.example`: canonical public HTTPS origin.
- Modify `docs/deployment/extremespace.md` and `docs/deployment/production-verification.md`: WSS deployment and verification commands.
- Modify API security/origin tests: assert `wss://pk.tianyi.wiki` derivation and reject insecure production origins.
- Modify `apps/web/src/features/games/GamePage.tsx` and its test: delayed fallback banner and compact game summary.
- Modify `apps/web/src/features/games/RoundTable.tsx` and its test: seat-count density classes.
- Modify `apps/web/src/app/AppShell.tsx` and its test: route-scoped focus mode.
- Modify `apps/web/index.html`: `viewport-fit=cover`.
- Modify `apps/web/src/styles/global.css`: responsive table geometry, highlighted player data, focus layout, and safe-area spacing.
- Modify `tests/e2e/game-flow.spec.ts`: mobile layout and polling-banner regression coverage.

### Task 1: Make the production realtime origin HTTPS/WSS

**Files:**
- Modify: `.env.extremespace.example`
- Modify: `apps/api/src/common/security/application-security.test.ts`
- Modify: `apps/api/src/realtime/websocket-origin.policy.test.ts`
- Modify: `docs/deployment/extremespace.md`
- Modify: `docs/deployment/production-verification.md`

**Interfaces:**
- Consumes: `PUBLIC_ORIGIN=https://pk.tianyi.wiki`.
- Produces: CSP `connect-src 'self' wss://pk.tianyi.wiki`.
- Preserves: same-origin Socket.IO path `/socket.io` and existing `ALLOWED_ORIGINS` parsing.

- [ ] **Step 1: Add failing security tests for the canonical production origin**

```ts
it('converts an HTTPS public origin to the matching WSS CSP source', () => {
  expect(websocketCspSources('https://pk.tianyi.wiki')).toEqual([
    'wss://pk.tianyi.wiki',
  ]);
});

it('accepts the HTTPS browser origin for the production socket', () => {
  const policy = createWebsocketOriginPolicy({
    publicOrigin: 'https://pk.tianyi.wiki',
    allowedOrigins: '',
  });
  expect(policy('https://pk.tianyi.wiki')).toBe(true);
  expect(policy('http://pk.tianyi.wiki')).toBe(false);
});
```

- [ ] **Step 2: Run the focused API tests**

Run: `pnpm --filter @poker/api test -- application-security.test.ts websocket-origin.policy.test.ts`

Expected: existing derivation tests pass; the insecure-origin assertion exposes any normalization that still accepts HTTP.

- [ ] **Step 3: Set the deployment example to HTTPS and document exact production checks**

```dotenv
PUBLIC_ORIGIN=https://pk.tianyi.wiki
ALLOWED_ORIGINS=https://pk.tianyi.wiki
```

Add these checks to the verification guide:

```powershell
curl.exe -fsSI https://pk.tianyi.wiki/api/health/live
curl.exe -fsS -D - -o NUL "https://pk.tianyi.wiki/socket.io/?EIO=4&transport=polling"
```

The guide must require inspecting the rendered CSP for `wss://pk.tianyi.wiki`, checking the browser Network panel for a `101 Switching Protocols` WebSocket, and confirming that the deployed secret values match the HTTPS example. Do not commit real deployment secrets.

- [ ] **Step 4: Re-run the tests and commit**

Run: `pnpm --filter @poker/api test -- application-security.test.ts websocket-origin.policy.test.ts`

Expected: PASS.

```bash
git add .env.extremespace.example apps/api/src/common/security/application-security.test.ts apps/api/src/realtime/websocket-origin.policy.test.ts docs/deployment/extremespace.md docs/deployment/production-verification.md
git commit -m "fix: require secure production realtime origin"
```

### Task 2: Show the polling warning only after fallback activates

**Files:**
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`

**Behavior:**
- `connecting`: no warning.
- `connected`: no warning and no polling interval.
- `polling`: warning text `实时连接中断，已启用每 10 秒定期同步` and one 10-second refresh interval.
- Reconnected: clear the interval and remove the warning immediately.

- [ ] **Step 1: Add fake-timer tests for the state transitions**

```tsx
it('does not warn during the initial socket connection grace period', async () => {
  vi.useFakeTimers();
  renderGame();
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();
});

it('warns only after fallback starts and removes the warning on reconnect', async () => {
  vi.useFakeTimers();
  const socket = renderGame().socket;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();
  socket.emitFromServer('connect');
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and observe the persistent-banner failure**

Run: `pnpm --filter @poker/web test -- GamePage.test.tsx`

Expected: FAIL because the current page renders the warning before the fallback state is reached.

- [ ] **Step 3: Render the warning from the polling state only**

```tsx
const showPollingFallback = realtimeMode === 'polling';

{showPollingFallback ? (
  <div className="connection-warning" role="status">
    实时连接中断，已启用每 10 秒定期同步
  </div>
) : null}
```

Keep timer setup and cleanup in one effect. The cleanup must clear both the connection-grace timeout and polling interval, including unmount and reconnect paths.

- [ ] **Step 4: Add an interval-count assertion, re-run, and commit**

Assert that two disconnect callbacks do not create two intervals, and that advancing 30 seconds results in exactly three polling refreshes.

Run: `pnpm --filter @poker/web test -- GamePage.test.tsx`

Expected: PASS.

```bash
git add apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx
git commit -m "fix: delay realtime fallback warning"
```

### Task 3: Make table geometry respond to occupied seats

**Files:**
- Modify: `apps/web/src/features/games/RoundTable.tsx`
- Modify: `apps/web/src/features/games/RoundTable.test.tsx`
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`
- Modify: `apps/web/src/styles/global.css`

**Interfaces:**
- Produces: `getTableDensity(occupiedSeatCount): 'sparse' | 'standard' | 'full'`.
- Density thresholds: 0-2 `sparse`, 3-8 `standard`, 9-12 `full`.
- Summary strip order: `玩家 X/12`, `总买入 ¥X`, `每手 ¥X`.

- [ ] **Step 1: Add failing density and summary tests**

```tsx
it.each([
  [0, 'round-table--sparse'],
  [2, 'round-table--sparse'],
  [3, 'round-table--standard'],
  [8, 'round-table--standard'],
  [9, 'round-table--full'],
  [12, 'round-table--full'],
])('uses the expected density for %i occupied seats', (count, className) => {
  render(<RoundTable {...propsWithOccupiedSeats(count)} />);
  expect(screen.getByTestId('round-table')).toHaveClass(className);
});

it('shows player count and the two primary table amounts above the table', () => {
  renderGame({ occupiedSeats: 2, totalBuyIn: '2700', handPrice: '300' });
  expect(screen.getByText('玩家 2/12')).toBeVisible();
  expect(screen.getByText('总买入 ¥2,700')).toBeVisible();
  expect(screen.getByText('每手 ¥300')).toBeVisible();
});
```

- [ ] **Step 2: Run the focused component tests**

Run: `pnpm --filter @poker/web test -- RoundTable.test.tsx GamePage.test.tsx`

Expected: FAIL because table geometry is currently fixed and the summary is inside the ellipse.

- [ ] **Step 3: Implement density classification and the external summary strip**

```tsx
export function getTableDensity(count: number) {
  if (count <= 2) return 'sparse';
  if (count <= 8) return 'standard';
  return 'full';
}

const occupiedCount = seats.filter((seat) => seat.player !== null).length;
const density = getTableDensity(occupiedCount);

return (
  <section
    className={`round-table round-table--${density}`}
    data-testid="round-table"
    aria-label={`牌桌，${occupiedCount} 名玩家`}
  >
    {/* existing seat positioning */}
  </section>
);
```

Move the timer, player count, total buy-in, and hand price into a compact `game-table-summary` immediately above `RoundTable`. Seat cards must use a solid/translucent backing so names, stacks, and buy-ins remain legible against the felt.

- [ ] **Step 4: Add responsive CSS for all three densities**

```css
.round-table--sparse { min-height: clamp(18rem, 52vw, 25rem); }
.round-table--standard { min-height: clamp(23rem, 64vw, 32rem); }
.round-table--full { min-height: clamp(29rem, 78vw, 39rem); }

.seat-card {
  background: color-mix(in srgb, var(--color-surface) 88%, transparent);
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  padding: 0.35rem 0.45rem;
}
```

Preserve the existing ellipse aspect and absolute seat anchors; density changes height and padding, not seat numbers.

- [ ] **Step 5: Re-run, inspect at mobile widths, and commit**

Run: `pnpm --filter @poker/web test -- RoundTable.test.tsx GamePage.test.tsx`

Expected: PASS.

Use browser responsive mode at 320x568, 390x844, and 430x932. Verify the sparse table no longer occupies most of the first screen, all visible player cards are readable, and 12 seats do not overlap controls.

```bash
git add apps/web/src/features/games/RoundTable.tsx apps/web/src/features/games/RoundTable.test.tsx apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx apps/web/src/styles/global.css
git commit -m "feat: make live table information first"
```

### Task 4: Add route-scoped focus mode and iPhone safe-area spacing

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/src/app/AppShell.test.tsx`
- Modify: `apps/web/src/styles/global.css`

**Interface:**
- Produces: `isFocusedGameRoute(pathname): boolean`.
- Focused routes: `/games/:id` and `/games/:id/settlement`.
- Non-focused routes: create, history, profile, admin, and settlement history details.

- [ ] **Step 1: Add failing route and viewport tests**

```tsx
it.each([
  ['/games/game-1', true],
  ['/games/game-1/settlement', true],
  ['/games/new', false],
  ['/history/game-1', false],
  ['/profile', false],
])('sets focus mode for %s', (pathname, focused) => {
  renderShell(pathname);
  const navigation = screen.queryByRole('navigation', { name: '主导航' });
  if (focused) expect(navigation).not.toBeInTheDocument();
  else expect(navigation).toBeVisible();
});
```

Also read `apps/web/index.html` in a Vitest assertion and require `viewport-fit=cover` in the viewport meta content.

- [ ] **Step 2: Run the AppShell tests**

Run: `pnpm --filter @poker/web test -- AppShell.test.tsx`

Expected: FAIL because the bottom navigation is always rendered and the viewport meta lacks `viewport-fit=cover`.

- [ ] **Step 3: Implement focus route detection and conditional navigation**

```tsx
export function isFocusedGameRoute(pathname: string) {
  return /^\/games\/[^/]+(?:\/settlement)?$/.test(pathname) && pathname !== '/games/new';
}

const { pathname } = useLocation();
const focused = isFocusedGameRoute(pathname);

return (
  <div className={focused ? 'app-shell app-shell--focus' : 'app-shell'}>
    <main>{children}</main>
    {focused ? null : <BottomNavigation aria-label="主导航" />}
  </div>
);
```

- [ ] **Step 4: Add a single-owner safe-area layout**

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

```css
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

.app-shell { padding-top: var(--safe-top); }
.app-shell--focus main { padding-bottom: calc(5.5rem + var(--safe-bottom)); }
.game-action-dock {
  bottom: 0;
  padding-bottom: calc(0.75rem + var(--safe-bottom));
}
```

The normal bottom navigation owns its own bottom safe-area padding. The focused main area owns only clearance for the sticky action dock; do not apply `--safe-bottom` to both a parent and child padding path.

- [ ] **Step 5: Re-run and commit**

Run: `pnpm --filter @poker/web test -- AppShell.test.tsx`

Expected: PASS.

```bash
git add apps/web/index.html apps/web/src/app/AppShell.tsx apps/web/src/app/AppShell.test.tsx apps/web/src/styles/global.css
git commit -m "feat: add focused safe area game layout"
```

### Task 5: Verify the complete mobile and realtime experience

**Files:**
- Modify: `tests/e2e/game-flow.spec.ts`

- [ ] **Step 1: Add a 390x844 focused-table Playwright scenario**

The scenario must create a game, enter the live route, and assert:

```ts
await page.setViewportSize({ width: 390, height: 844 });
await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
await expect(page.getByText(/实时连接中断/)).toHaveCount(0);
await expect(page.getByText('玩家 0/12')).toBeVisible();
await expect(page.getByTestId('round-table')).toHaveClass(/round-table--sparse/);
```

Then block the Socket.IO endpoint before navigation, advance beyond the grace period, and assert the fallback warning becomes visible once. Restore the route, reconnect, and assert it disappears.

- [ ] **Step 2: Run the E2E scenario**

Run: `pnpm test:e2e -- game-flow.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run package-wide verification**

Run:

```bash
pnpm --filter @poker/api lint
pnpm --filter @poker/api typecheck
pnpm --filter @poker/api test
pnpm --filter @poker/web lint
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web test
pnpm --filter @poker/web build
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit the E2E coverage**

```bash
git add tests/e2e/game-flow.spec.ts
git commit -m "test: cover mobile table realtime fallback"
```

## Production Acceptance Checklist

- Open `https://pk.tianyi.wiki` on iPhone Safari and Android Chrome.
- Confirm the WebSocket request upgrades with status 101 and no mixed-content/CSP console error.
- Keep the table open for at least 30 seconds; the fallback warning must remain absent while connected.
- Disable the network long enough to activate polling; the warning must appear, data must refresh every 10 seconds, and the warning must disappear after recovery.
- Confirm 0, 2, 8, and 12 occupied-seat layouts at 390 CSS px width.
- Confirm the home indicator overlaps neither the focused game actions nor normal bottom navigation.
