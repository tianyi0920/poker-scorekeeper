# User-Owned Game Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有正常登录用户都能创建对局，并让普通用户只管理、结束和结算自己创建的对局，同时保持管理员跨对局管理能力和现有高风险操作限制。

**Architecture:** 在共享 `GameSnapshotDto` 中加入 actor-neutral 的 `createdById`，前端据此决定是否显示生命周期入口；服务端在锁定用户与对局后统一调用“管理员或创建者”策略，作为真正授权边界。创建、开始结算、保存草稿和最终确认按新规则开放；草稿接管、删除、作废及超级管理员管理页维持原权限。

**Tech Stack:** TypeScript, Zod, NestJS 11, Prisma 7, React 19, Vitest 3, Supertest, Playwright 1.55

**Spec:** `docs/superpowers/specs/2026-08-27-user-owned-games-compact-home-exact-equity-design.md`

## Global Constraints

- [ ] 不新增 Prisma 字段或迁移；复用现有 `Game.createdById`。
- [ ] 所有写权限必须在事务中基于锁定后的用户和对局重新判断，不能只依赖控制器装饰器或前端按钮。
- [ ] `GET settlement-draft` 与 `POST settlement-preview` 保持现有只读查看权限。
- [ ] `settlement-draft/takeover`、删除草稿和作废对局仍只允许管理员；硬删除与管理列表仍只允许超级管理员。
- [ ] 继续保留全局最多 5 场、进行中名称唯一、状态机、租约、版本、确认令牌、审计和实时推送行为。
- [ ] 先写能证明旧行为错误的测试并确认 RED，再写最小实现；每个任务独立提交。

## File and Interface Map

- `packages/contracts/src/games.ts` — `gameSnapshotSchema` 新增必填 `createdById`。
- `packages/contracts/src/games.test.ts` — 证明缺少/非法创建者 ID 会被拒绝。
- `apps/api/src/games/game-snapshot.mapper.ts` — 将数据库 `createdById` 映射到 REST 与 Socket 共用快照。
- `apps/api/src/games/game-policy.ts` — 新增并集中实现 `assertCanManageGameLifecycle(actor, game)`。
- `apps/api/src/games/games.service.ts` — 将“锁用户”与“角色/所有权授权”拆开，按操作选择策略。
- `apps/api/src/games/games.controller.ts` — 只为创建和开始结算放行 `USER` 到服务层。
- `apps/api/src/settlements/settlement-draft.service.ts` — 保存草稿用统一所有权策略；接管继续用管理员策略。
- `apps/api/src/settlements/settlement-draft.controller.ts` — 保存草稿放行 `USER`；接管装饰器不变。
- `apps/api/src/settlements/settlement-finalization.service.ts` — 最终确认用统一所有权策略。
- `apps/api/src/settlements/settlement-finalization.controller.ts` — 最终确认放行 `USER`。
- `apps/web/src/features/games/game-permissions.ts` — 产生纯函数 `canManageGameLifecycle(actor, game)` 供页面复用。
- `apps/web/src/features/home/HomePage.tsx` — 所有正常会话均显示创建入口。
- `apps/web/src/features/games/GamePage.tsx` — 创建者或管理员显示“结束对局/继续结算”。
- API 与浏览器测试 — 覆盖本人完整流程、他人拒绝和管理员不回归。

---

### Task 1: Extend the actor-neutral game snapshot contract

**Files:**

- Modify: `packages/contracts/src/games.ts`
- Modify: `packages/contracts/src/games.test.ts`
- Modify: `apps/api/src/games/game-snapshot.mapper.ts`
- Modify: `apps/api/src/settlements/settlement-preview.mapper.test.ts`
- Modify: fixtures constructing `GameSnapshotDto` as reported by TypeScript/tests

- [ ] **Step 1: Write the failing contract tests**

Add `createdById` to the valid `snapshot()` fixture and assert it is required and strict:

```ts
it('requires the game creator id in every snapshot', () => {
  expect(gameSnapshotSchema.parse(snapshot()).createdById).toBe('user-creator');
  const { createdById: _removed, ...missing } = snapshot();
  expect(gameSnapshotSchema.safeParse(missing).success).toBe(false);
});
```

Also add a mapper assertion that a database record with `createdById: 'user-creator'` returns the same value.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
pnpm --filter @poker/contracts exec vitest run src/games.test.ts
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/settlements/settlement-preview.mapper.test.ts
```

Expected: FAIL because the schema and mapper do not yet expose `createdById`.

- [ ] **Step 3: Implement the minimal contract and mapping change**

Add a required string field:

```ts
export const gameSnapshotSchema = z.object({
  id: z.string(),
  createdById: z.string(),
  // existing fields unchanged
});
```

Extend `SnapshotGameRecord` and return `createdById: game.createdById` from `mapGameSnapshot`. Update every typed fixture with a stable creator ID; do not make the field optional and do not add viewer-specific `canManageLifecycle` to the shared snapshot.

- [ ] **Step 4: Re-run focused tests and type-check consumers**

Run:

```powershell
pnpm --filter @poker/contracts exec vitest run src/games.test.ts
pnpm --filter @poker/contracts build
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/settlements/settlement-preview.mapper.test.ts
pnpm --filter @poker/web typecheck
```

Expected: PASS. If TypeScript reveals snapshot literals elsewhere, add `createdById` to those fixtures without weakening the schema.

- [ ] **Step 5: Commit the contract slice**

```powershell
git add packages/contracts/src/games.ts packages/contracts/src/games.test.ts apps/api/src/games/game-snapshot.mapper.ts apps/api/src/settlements/settlement-preview.mapper.test.ts apps/web/src apps/api/test
git commit -m "feat: expose game creator in snapshots"
```

### Task 2: Add and prove the central manager-or-owner policy

**Files:**

- Modify: `apps/api/src/games/game-policy.ts`
- Modify: `apps/api/src/games/game-policy.test.ts`

- [ ] **Step 1: Write the failing policy matrix**

Cover administrators, owners, other users, and stale/deactivated actors:

```ts
it.each(['ADMIN', 'SUPER_ADMIN'] as const)('lets %s manage any game', (role) => {
  expect(() => assertCanManageGameLifecycle(
    { id: 'admin', role },
    { createdById: 'someone-else' }
  )).not.toThrow();
});

it('lets a regular user manage only a game they created', () => {
  expect(() => assertCanManageGameLifecycle(
    { id: 'owner', role: 'USER' },
    { createdById: 'owner' }
  )).not.toThrow();
  expect(() => assertCanManageGameLifecycle(
    { id: 'outsider', role: 'USER' },
    { createdById: 'owner' }
  )).toThrowErrorMatchingObject({ code: 'FORBIDDEN' });
});
```

Keep `assertGameManager` and add a test proving it still rejects `USER`, because takeover/delete/void continue to use it. Current-user activity/deletion remains enforced by `requireCurrentActor`; add integration coverage in later tasks rather than duplicating that logic here.

- [ ] **Step 2: Run the focused policy test and confirm RED**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/games/game-policy.test.ts
```

Expected: FAIL because `assertCanManageGameLifecycle` is absent.

- [ ] **Step 3: Implement the pure policy**

Implement one exported function accepting only the fields it needs:

```ts
export function assertCanManageGameLifecycle(
  actor: Pick<AuthUser, 'id' | 'role'>,
  game: Pick<Game, 'createdById'>
): void {
  if (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') return;
  if (actor.role === 'USER' && actor.id === game.createdById) return;
  throw forbidden('FORBIDDEN');
}
```

Use a structural `{ createdById: string }` type instead of importing a Prisma model if that keeps the policy module easier to unit-test.

- [ ] **Step 4: Re-run the policy tests**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/games/game-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the policy**

```powershell
git add apps/api/src/games/game-policy.ts apps/api/src/games/game-policy.test.ts
git commit -m "feat: authorize game managers and creators"
```

### Task 3: Open game creation and owner-controlled settlement start

**Files:**

- Modify: `apps/api/src/games/games.controller.ts`
- Modify: `apps/api/src/games/games.service.ts`
- Modify: `apps/api/test/games.e2e-spec.ts`
- Modify: `apps/api/test/games-concurrency.integration-spec.ts`

- [ ] **Step 1: Add failing API examples**

In `games.e2e-spec.ts`, add cases proving:

- `USER` can `POST /api/games`, receives `201`, and the response plus persisted row use that user's ID as `createdById`;
- the creator can `POST /api/games/:id/begin-settlement`;
- a different `USER` receives `403` with code `FORBIDDEN` for the same endpoint;
- `ADMIN` can still begin settlement for another user's game;
- `USER` still receives `403` for `start`, `draft` deletion and `void` routes.

In the concurrency suite, create a user-owned active game and prove two concurrent begin-settlement attempts yield exactly one success/state transition and one existing conflict response. Preserve the existing demotion race test, adapting its expected result only where the actor is also the creator.

- [ ] **Step 2: Run the API tests and confirm RED**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/games.e2e-spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.integration.config.ts test/games-concurrency.integration-spec.ts
```

Expected: new `USER` create/begin-settlement cases fail at controller guards or `assertGameManager`.

- [ ] **Step 3: Refactor actor locking without weakening restricted methods**

Replace `lockAndAuthorizeActor` with a neutral lock helper:

```ts
private async lockCurrentActor(transaction: Prisma.TransactionClient, actorId: string) {
  const locked = await lockUsersInOrder(transaction, [actorId]);
  return requireCurrentActor(locked, actorId);
}
```

Then apply authorization per method:

- `create`: lock active actor only; any role may continue.
- `beginSettlement`: lock game and actor, then call `assertCanManageGameLifecycle(currentActor, before)` before the transition.
- `start`, `deleteDraft`, `void`: continue calling `assertGameManager(currentActor)` exactly as before.

Do not authorize against the untrusted session object or an unlocked earlier query.

- [ ] **Step 4: Widen only the required controller decorators**

Allow `Role.USER` on `POST /games` and `POST /games/:id/begin-settlement`. Keep decorators for `start`, `deleteDraft`, `void`, hard delete and manage unchanged.

- [ ] **Step 5: Re-run focused API and concurrency tests**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/games.e2e-spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.integration.config.ts test/games-concurrency.integration-spec.ts
```

Expected: PASS with one-writer semantics intact.

- [ ] **Step 6: Commit game creation and lifecycle authorization**

```powershell
git add apps/api/src/games/games.controller.ts apps/api/src/games/games.service.ts apps/api/test/games.e2e-spec.ts apps/api/test/games-concurrency.integration-spec.ts
git commit -m "feat: let users create and end owned games"
```

### Task 4: Allow owners to save and finalize only their own settlement

**Files:**

- Modify: `apps/api/src/settlements/settlement-draft.controller.ts`
- Modify: `apps/api/src/settlements/settlement-draft.service.ts`
- Modify: `apps/api/src/settlements/settlement-finalization.controller.ts`
- Modify: `apps/api/src/settlements/settlement-finalization.service.ts`
- Modify: `apps/api/test/settlement-draft.e2e-spec.ts`
- Modify: `apps/api/test/settlement-finalization.e2e-spec.ts`
- Modify: `apps/api/test/settlement-concurrency.integration-spec.ts`

- [ ] **Step 1: Add failing settlement permission tests**

Create fixtures where `playerA` is the creator/editor and `playerB` is an unrelated user. Prove:

- creator receives `canEdit: true`, saves a valid draft, previews it, and finalizes it;
- unrelated user can retain existing read/preview access but receives `403 FORBIDDEN` on save and finalize;
- creator receives `403` when attempting to save/finalize another user's game;
- any ordinary user receives `403` on takeover, including after lease expiry;
- an administrator can save/finalize another user's game when holding the editor lease and can still take over after expiry;
- a creator who is disabled/deleted between session issuance and write is rejected by the existing current-user check.

Add a concurrency test proving creator/admin finalization races still persist only one immutable settlement.

- [ ] **Step 2: Run the settlement suites and confirm RED**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/settlement-draft.e2e-spec.ts test/settlement-finalization.e2e-spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.integration.config.ts test/settlement-concurrency.integration-spec.ts
```

Expected: creator write cases fail because controllers/services are admin-only.

- [ ] **Step 3: Apply the central policy to draft save**

After locking the game and current actor, call `assertCanManageGameLifecycle(currentActor, game)` in `save`. Keep `takeover` on `assertGameManager`.

Update `toDraftDto` so `canEdit` is true only when both conditions hold:

```text
actor.id === draft.editorUserId
and
actor is ADMIN/SUPER_ADMIN or actor.id === context.game.createdById
```

Keep `canTakeOver` role-only and lease-expiry-dependent.

- [ ] **Step 4: Apply the central policy to finalization**

In `SettlementFinalizationService.finalize`, call the owner policy after locking `game` and the actor. Do not weaken editor ownership, draft version, settings version, confirmation token, balance validation or serialization checks.

Allow `Role.USER` only on the draft `PUT` and finalization `POST` controller methods. Keep takeover admin-only. Do not add a role decorator to read/preview routes if they currently rely on authenticated view policy.

- [ ] **Step 5: Re-run settlement tests**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/settlement-draft.e2e-spec.ts test/settlement-finalization.e2e-spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.integration.config.ts test/settlement-concurrency.integration-spec.ts
```

Expected: PASS, including old administrator takeover and conflict cases.

- [ ] **Step 6: Commit settlement ownership**

```powershell
git add apps/api/src/settlements apps/api/test/settlement-draft.e2e-spec.ts apps/api/test/settlement-finalization.e2e-spec.ts apps/api/test/settlement-concurrency.integration-spec.ts
git commit -m "feat: let creators settle owned games"
```

### Task 5: Reflect ownership safely in the React UI

**Files:**

- Create: `apps/web/src/features/games/game-permissions.ts`
- Create: `apps/web/src/features/games/game-permissions.test.ts`
- Modify: `apps/web/src/features/home/HomePage.tsx`
- Modify: `apps/web/src/features/home/HomePage.test.tsx`
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`

- [ ] **Step 1: Write failing UI permission tests**

Add a pure matrix for the client helper matching the server rule. Update component tests to prove:

- a regular user sees “创建对局” and an empty-state “创建一场”;
- the 5-game capacity still disables creation for every role;
- a regular user whose session ID equals `snapshot.createdById` sees “结束对局” on ACTIVE and “继续结算” on SETTLING;
- a different regular user sees neither control;
- administrators retain both controls regardless of creator.

- [ ] **Step 2: Run focused web tests and confirm RED**

```powershell
pnpm --filter @poker/web exec vitest run src/features/home/HomePage.test.tsx src/features/games/GamePage.test.tsx src/features/games/game-permissions.test.ts
```

Expected: regular-user create and owner control assertions fail.

- [ ] **Step 3: Implement one client-side visibility helper**

```ts
export function canManageGameLifecycle(
  actor: Pick<AuthUserContract, 'id' | 'role'> | null | undefined,
  game: Pick<GameSnapshotDto, 'createdById'>
): boolean {
  return actor !== null && actor !== undefined && (
    actor.role === 'ADMIN' ||
    actor.role === 'SUPER_ADMIN' ||
    actor.id === game.createdById
  );
}
```

Use it only for visibility. API errors remain authoritative.

- [ ] **Step 4: Update the two pages**

In `HomePage`, remove the role-only gate around both create links but keep loading/error/capacity behavior. In `GamePage`, replace the role-only `canManage` expression with the shared helper after both session and snapshot are available. Preserve existing failure recovery: close/retain dialogs according to current tested behavior, refresh the snapshot after conflicts, and never navigate to settlement on a failed request.

- [ ] **Step 5: Re-run focused web tests**

```powershell
pnpm --filter @poker/web exec vitest run src/features/home/HomePage.test.tsx src/features/games/GamePage.test.tsx src/features/games/game-permissions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit UI ownership behavior**

```powershell
git add apps/web/src/features/home apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx apps/web/src/features/games/game-permissions.ts apps/web/src/features/games/game-permissions.test.ts
git commit -m "feat: show lifecycle controls to game creators"
```

### Task 6: Prove the complete owner journey and permission boundaries

**Files:**

- Modify: `tests/e2e/permissions.spec.ts`
- Modify: `tests/e2e/game-flow.spec.ts`
- Modify only if needed: `tests/e2e/support/games.ts`
- Modify only if needed: `tests/e2e/support/settlement.ts`

- [ ] **Step 1: Add the browser-level permission journey**

Using two regular-user sessions plus an administrator fixture, cover:

1. User A creates a game from the homepage.
2. The returned/current snapshot identifies User A as creator.
3. User A enters the game, ends it, completes the settlement wizard and reaches completed history.
4. User B can view the active/settling game according to existing rules but has no lifecycle controls.
5. Direct User B write requests to begin settlement, save draft and finalize return `403 FORBIDDEN`.
6. Admin controls and takeover still work.

Keep cleanup scoped to fixture IDs through existing support helpers.

- [ ] **Step 2: Run the focused browser tests**

```powershell
pnpm exec playwright test tests/e2e/permissions.spec.ts tests/e2e/game-flow.spec.ts --project=chromium-360x800
```

Expected: PASS.

- [ ] **Step 3: Run the entire API and web unit/integration surface for this slice**

```powershell
pnpm --filter @poker/contracts test
pnpm --filter @poker/api test
pnpm --filter @poker/web test
pnpm typecheck
pnpm lint
```

Expected: PASS with no snapshot fixtures, route guards or stale role assumptions left behind.

- [ ] **Step 4: Commit the journey tests**

```powershell
git add tests/e2e/permissions.spec.ts tests/e2e/game-flow.spec.ts tests/e2e/support
git commit -m "test: cover user-owned game lifecycle"
```

## Completion Evidence

- [ ] Capture the exact focused RED command/output before each implementation task.
- [ ] Capture passing focused tests after each task.
- [ ] Confirm `rg -n "assertGameManager" apps/api/src/games apps/api/src/settlements` shows role-only checks only on intentionally restricted operations.
- [ ] Confirm `rg -n "createdById" packages/contracts/src apps/api/src apps/web/src` covers contract, mapping and UI visibility.
- [ ] Do not claim this plan complete until full tests in Task 6 pass.
