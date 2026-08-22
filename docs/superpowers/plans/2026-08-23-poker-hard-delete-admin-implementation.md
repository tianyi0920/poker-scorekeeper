# Poker Super-Admin Hard Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give only super administrators a discoverable, paginated all-status game-management page and a one-confirmation operation that permanently removes a game and every business child row while preserving one minimal audit record.

**Architecture:** Add a management query and hard-delete transaction to the games module. The delete transaction takes the shared lifecycle coordinator lock, row-locks the game and actor, deletes dependents in explicit foreign-key order, then records `GAME_HARD_DELETED`. After commit, the realtime service emits `game.deleted`, removes sockets from the game room, and clears in-memory presence; open web views immediately return home with a notice.

**Tech Stack:** NestJS 11, Prisma 7/MariaDB, Socket.IO 4, React 19, React Router 7, Zod 4, Vitest, Supertest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-22-poker-scorekeeper-ux-hard-delete-design.md`

## Global Constraints

- `DELETE /api/games/:id` is `SUPER_ADMIN` only and accepts no status or soft-delete body.
- Every status is deletable: `DRAFT`, `ACTIVE`, `SETTLING`, `COMPLETED`, and `VOIDED`.
- The delete is one database transaction and leaves no game, player, buy-in, lock, settlement draft, settlement, result, or fee-allocation row.
- Preserve exactly one minimal `GAME_HARD_DELETED` audit entry containing public game ID, name, prior status, deletion time, and actor; never include financial payloads, credentials, cookies, tokens, connection strings, or avatar files.
- Duplicate deletion returns `404 NOT_FOUND` and creates no second audit entry.
- Delete confirmation appears once. There is no typed-name challenge and no second dialog.
- Pagination is server-side, ordered by `createdAt DESC, id DESC`, with an opaque cursor.
- Do not add a Prisma migration; the existing schema supports the operation.

---

## File Structure

- Modify `packages/contracts/src/games.ts` and its test: managed-game page and delete response schemas.
- Modify `packages/contracts/src/realtime.ts` and its test: `game.deleted` event.
- Create `apps/api/src/games/game-management.service.ts`: paginated management list and hard-delete transaction.
- Modify `apps/api/src/games/games.controller.ts` and `games.module.ts`: routes/provider wiring.
- Create `apps/api/test/game-management.e2e-spec.ts`: authorization, pagination, every status, audit, and child cleanup.
- Create `apps/api/test/game-hard-delete.integration-spec.ts`: lock/concurrency behavior.
- Modify realtime presence/event services and tests: post-commit deletion broadcast and room cleanup.
- Create `apps/web/src/features/games/GameManagementPage.tsx` and test.
- Create `apps/web/src/features/games/DeleteGameDialog.tsx` and test.
- Create `apps/web/src/features/games/useGameDeletedSubscription.ts` and test.
- Modify router/profile/API resources/game/settlement/home files and tests: route, entry, request, and redirect behavior.
- Create `tests/e2e/game-hard-delete.spec.ts`: browser-visible destructive flow and database proof.

### Task 1: Define management and deletion contracts

**Files:**
- Modify: `packages/contracts/src/games.ts`
- Modify: `packages/contracts/src/games.test.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Modify: `packages/contracts/src/realtime.test.ts`

**Interfaces:**
- Produces: `ManagedGameDto` with `id`, `name`, `status`, `createdAt`, `startedAt`, `completedAt`, and `playerCount`.
- Produces: `ManagedGamesResponseDto` with `items` and `nextCursor`.
- Produces: `HardDeleteGameResponseDto` with `deletedGameId`.
- Produces: `GameDeletedEvent` with `gameId` and literal reason `HARD_DELETED`.

- [ ] **Step 1: Add failing exact-shape tests**

```ts
it('parses a paginated all-status management page', () => {
  expect(managedGamesResponseSchema.parse({
    items: [{
      id: 'cm123456789012345678901234', name: '测试局', status: 'VOIDED',
      createdAt: '2026-08-23T01:02:03.000+00:00', startedAt: null,
      completedAt: null, playerCount: 0,
    }],
    nextCursor: 'eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTIzVDAxOjAyOjAzLjAwMFoiLCJpZCI6ImNtMSJ9',
  }).items[0]?.status).toBe('VOIDED');
});

it('accepts only the hard-delete realtime reason', () => {
  expect(gameDeletedEventSchema.parse({
    gameId: 'cm123456789012345678901234', reason: 'HARD_DELETED',
  })).toEqual({ gameId: 'cm123456789012345678901234', reason: 'HARD_DELETED' });
});
```

- [ ] **Step 2: Run the contract tests**

Run: `pnpm --filter @poker/contracts test -- games.test.ts realtime.test.ts`

Expected: FAIL because neither response nor deletion event exists.

- [ ] **Step 3: Implement strict Zod schemas**

```ts
export const managedGameSchema = z.object({
  id: canonicalPublicIdSchema,
  name: gameNameSchema,
  status: gameStatusSchema,
  createdAt: offsetDateTimeSchema,
  startedAt: offsetDateTimeSchema.nullable(),
  completedAt: offsetDateTimeSchema.nullable(),
  playerCount: z.number().int().min(0).max(12),
}).strict();

export const managedGamesResponseSchema = z.object({
  items: z.array(managedGameSchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const hardDeleteGameResponseSchema = z.object({
  deletedGameId: canonicalPublicIdSchema,
}).strict();

export const gameDeletedEventSchema = z.object({
  gameId: canonicalPublicIdSchema,
  reason: z.literal('HARD_DELETED'),
}).strict();
```

- [ ] **Step 4: Re-run and commit**

Run: `pnpm --filter @poker/contracts test -- games.test.ts realtime.test.ts`

Expected: PASS.

```bash
git add packages/contracts/src/games.ts packages/contracts/src/games.test.ts packages/contracts/src/realtime.ts packages/contracts/src/realtime.test.ts
git commit -m "feat: define game management deletion contracts"
```

### Task 2: Add the super-admin paginated management query

**Files:**
- Create: `apps/api/src/games/game-management.service.ts`
- Modify: `apps/api/src/games/games.controller.ts`
- Modify: `apps/api/src/games/games.module.ts`
- Create: `apps/api/test/game-management.e2e-spec.ts`

**Interface:**
- `GET /api/games/manage?limit=50&cursor=...`
- Limit range 1-50; default 50.
- Cursor encodes `{ createdAt: ISO string, id: public ID }` as base64url JSON and is validated before querying.
- Ordering and seek predicate: earlier `createdAt`, or same `createdAt` with lexically smaller `id`.

- [ ] **Step 1: Add failing authorization and pagination tests**

```ts
it.each([
  ['anonymous', undefined, 401],
  ['user', userAuth, 403],
  ['admin', adminAuth, 403],
])('rejects %s from the management list', async (_label, auth, status) => {
  await read(auth, '/api/games/manage?limit=2').expect(status);
});

it('returns every status in stable cursor order to a super administrator', async () => {
  await seedOneGamePerStatus();
  const first = await read(superAdminAuth, '/api/games/manage?limit=2').expect(200);
  expect(first.body.items).toHaveLength(2);
  expect(first.body.nextCursor).toEqual(expect.any(String));
  const second = await read(
    superAdminAuth,
    `/api/games/manage?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  ).expect(200);
  expect(new Set([...first.body.items, ...second.body.items].map(({ id }) => id)).size).toBe(4);
});
```

Also test malformed cursor `400 VALIDATION_ERROR`, limit 0/51 rejection, equal-timestamp ID tie-breaking, `playerCount`, and a final page returning `nextCursor: null`.

- [ ] **Step 2: Run the E2E file and verify the missing-route failure**

Run: `pnpm --filter @poker/api test:e2e -- game-management.e2e-spec.ts`

Expected: FAIL because `/api/games/manage` does not exist.

- [ ] **Step 3: Implement cursor encode/decode and the seek query**

```ts
const managementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().min(1).optional(),
}).strict();

const rows = await this.prisma.game.findMany({
  where: cursor === undefined ? undefined : {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: limit + 1,
  include: { _count: { select: { players: true } } },
});
```

Use `limit + 1` to decide whether a next cursor exists; return only `limit` items. Encode only the last returned item's timestamp and ID. Do not expose SQL offsets.

- [ ] **Step 4: Register a static route before `@Get(':id/snapshot')`**

```ts
@Get('manage')
@Roles(Role.SUPER_ADMIN)
manage(@Query(new ZodValidationPipe(managementQuerySchema)) query: ManagementQuery) {
  return this.gameManagement.list(query);
}
```

- [ ] **Step 5: Re-run and commit**

Run: `pnpm --filter @poker/api test:e2e -- game-management.e2e-spec.ts`

Expected: PASS.

```bash
git add apps/api/src/games/game-management.service.ts apps/api/src/games/games.controller.ts apps/api/src/games/games.module.ts apps/api/test/game-management.e2e-spec.ts
git commit -m "feat: list all games for super administrators"
```

### Task 3: Implement the locked hard-delete transaction

**Files:**
- Modify: `apps/api/src/games/game-management.service.ts`
- Modify: `apps/api/src/games/games.controller.ts`
- Modify: `apps/api/test/game-management.e2e-spec.ts`
- Create: `apps/api/test/game-hard-delete.integration-spec.ts`
- Reuse: `apps/api/src/games/game-lifecycle-coordinator.ts`
- Reuse: `apps/api/src/games/game-lock.ts`
- Reuse: `apps/api/src/audit/audit.service.ts`

**Interfaces:**
- `DELETE /api/games/:id` returns `200 { deletedGameId }`.
- `GameManagementService.hardDelete(id, actor): Promise<HardDeleteGameResponseDto>`.
- The shared lifecycle coordinator is the same lock used by atomic game creation.

- [ ] **Step 1: Add failing permission, status matrix, and cleanup tests**

```ts
it.each(['DRAFT', 'ACTIVE', 'SETTLING', 'COMPLETED', 'VOIDED'] as const)(
  'hard deletes a %s game and all business descendants',
  async (status) => {
    const fixture = await seedGameGraph(status);
    await write(superAdminAuth, 'delete', `/api/games/${fixture.gameId}`).expect(200, {
      deletedGameId: fixture.gameId,
    });
    await expectGameGraphCounts(fixture, {
      games: 0, gamePlayers: 0, buyinEvents: 0, activePlayerLocks: 0,
      settlementDrafts: 0, settlements: 0, settlementResults: 0,
      settlementFeeAllocations: 0,
    });
    expect(await prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: fixture.gameId },
    })).toBe(1);
  },
);
```

Test anonymous `401`, user/admin `403`, first delete `200`, second delete `404 NOT_FOUND`, no second audit, and audit JSON containing only `{ id, name, status, deletedAt }`.

- [ ] **Step 2: Add a controlled lock-race integration test**

Open transaction A, take the lifecycle coordinator and target game row locks, and start both an API buy-in request and a hard-delete request. Release transaction A so delete wins the target-row race. Assert delete succeeds, buy-in returns `404 NOT_FOUND` or the documented conflict, and all target business rows are absent. Repeat with settlement finalization as the contender. This test proves the shared row lock prevents an orphan write after deletion.

- [ ] **Step 3: Run focused backend tests**

Run:

```bash
pnpm --filter @poker/api test:e2e -- game-management.e2e-spec.ts
pnpm --filter @poker/api test:integration -- game-hard-delete.integration-spec.ts
```

Expected: FAIL because the delete endpoint and transaction are missing.

- [ ] **Step 4: Lock coordinator, target, and actor inside one transaction**

```ts
return this.prisma.$transaction(async (transaction) => {
  await lockGameLifecycleCoordinator(transaction);
  const game = await lockGameForUpdate(transaction, id);
  const [operator] = await transaction.$queryRaw<Array<{
    id: string; role: Role; isActive: boolean | number; deletedAt: Date | null;
  }>>`
    SELECT id, role, is_active AS isActive, deleted_at AS deletedAt
    FROM users WHERE id = ${actor.id} FOR UPDATE
  `;
  if (
    operator === undefined || operator.role !== Role.SUPER_ADMIN
    || !databaseBoolean(operator.isActive) || operator.deletedAt !== null
  ) throw forbidden('FORBIDDEN');

  const deletedAt = new Date();
  const auditBefore = {
    id: game.id, name: game.name, status: game.status, deletedAt: deletedAt.toISOString(),
  };
  // delete graph in Step 5, then record audit and return
});
```

Do not trust the session role alone. Revalidation is deliberately inside the transaction.

- [ ] **Step 5: Delete in explicit foreign-key order and record the minimal audit**

```ts
const settlements = await transaction.settlement.findMany({
  where: { gameId: id }, select: { id: true },
});
const settlementIds = settlements.map(({ id: settlementId }) => settlementId);
await transaction.settlementFeeAllocation.deleteMany({ where: { settlementId: { in: settlementIds } } });
await transaction.settlementResult.deleteMany({ where: { settlementId: { in: settlementIds } } });
await transaction.settlement.deleteMany({ where: { gameId: id } });
await transaction.settlementDraft.deleteMany({ where: { gameId: id } });
await transaction.buyinEvent.deleteMany({ where: { gameId: id } });
await transaction.activePlayerLock.deleteMany({ where: { gameId: id } });
await transaction.gamePlayer.deleteMany({ where: { gameId: id } });
await transaction.game.delete({ where: { id } });
await this.audit.record(transaction, {
  actorUserId: actor.id,
  action: 'GAME_HARD_DELETED', entityType: 'GAME', entityId: id,
  before: auditBefore,
});
return { deletedGameId: id };
```

An empty settlement ID array must produce safe zero-row deletes. Do not delete older audit entries for the game; business queries ignore audit storage, and the new hard-delete record is intentionally retained.

- [ ] **Step 6: Add the controller endpoint and re-run**

```ts
@Delete(':id')
@HttpCode(200)
@Roles(Role.SUPER_ADMIN)
hardDelete(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
  return this.gameManagement.hardDelete(id, actor);
}
```

Run:

```bash
pnpm --filter @poker/api test:e2e -- game-management.e2e-spec.ts
pnpm --filter @poker/api test:integration -- game-hard-delete.integration-spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/games/game-management.service.ts apps/api/src/games/games.controller.ts apps/api/test/game-management.e2e-spec.ts apps/api/test/game-hard-delete.integration-spec.ts
git commit -m "feat: permanently delete games transactionally"
```

### Task 4: Broadcast deletion and clear realtime presence after commit

**Files:**
- Modify: `apps/api/src/realtime/presence.service.ts`
- Create: `apps/api/src/realtime/presence.service.test.ts`
- Modify: `apps/api/src/realtime/game-events.service.ts`
- Create: `apps/api/src/realtime/game-events.service.test.ts`
- Modify: `apps/api/src/games/game-management.service.ts`

**Interfaces:**
- Produces: `PresenceService.clear(gameId): void`.
- Produces: `GameEventsService.publishDeletedGame(gameId): Promise<void>`.
- Emits: `game.deleted` exactly once to each still-authenticated socket in `game:${gameId}`.

- [ ] **Step 1: Add failing room-clear and broadcast tests**

```ts
it('clears every in-memory spectator for one game only', async () => {
  presence.add('g1', 'u1', 's1');
  presence.add('g2', 'u2', 's2');
  presence.clear('g1');
  expect(presence.hasConnection('g1', 'u1', 's1')).toBe(false);
  expect(presence.hasConnection('g2', 'u2', 's2')).toBe(true);
});

it('emits deletion, leaves the room, and clears presence without querying a deleted game', async () => {
  await events.publishDeletedGame('g1');
  expect(socket.emit).toHaveBeenCalledWith('game.deleted', {
    gameId: 'g1', reason: 'HARD_DELETED',
  });
  expect(socket.leave).toHaveBeenCalledWith('game:g1');
  expect(presence.clear).toHaveBeenCalledWith('g1');
  expect(prisma.game.findUnique).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused realtime tests**

Run: `pnpm --filter @poker/api test -- presence.service.test.ts game-events.service.test.ts`

Expected: FAIL because clear/publish methods are absent.

- [ ] **Step 3: Implement deletion broadcast without post-delete game lookup**

Iterate the existing room IDs, revalidate each socket session, emit the non-sensitive deletion event to authenticated members, call `socket.leave`, clear `socket.data.gameId`, then call `presence.clear(gameId)` in `finally`. A session failure disconnects that socket. The method must not authorize against a `Game` record because the transaction has already removed it.

- [ ] **Step 4: Publish after the transaction commits without changing deletion success**

`hardDelete` first awaits the successful transaction, then calls `publishDeletedGame`. Catch and log a realtime-publish error through Nest `Logger`; return the successful delete response because the permanent database outcome is already committed. Do not emit before commit.

- [ ] **Step 5: Re-run and commit**

Run: `pnpm --filter @poker/api test -- presence.service.test.ts game-events.service.test.ts`

Expected: PASS.

```bash
git add apps/api/src/realtime/presence.service.ts apps/api/src/realtime/presence.service.test.ts apps/api/src/realtime/game-events.service.ts apps/api/src/realtime/game-events.service.test.ts apps/api/src/games/game-management.service.ts
git commit -m "feat: broadcast hard deleted games"
```

### Task 5: Build the one-confirmation game-management UI

**Files:**
- Create: `apps/web/src/features/games/GameManagementPage.tsx`
- Create: `apps/web/src/features/games/GameManagementPage.test.tsx`
- Create: `apps/web/src/features/games/DeleteGameDialog.tsx`
- Create: `apps/web/src/features/games/DeleteGameDialog.test.tsx`
- Modify: `apps/web/src/api/resources.ts`
- Modify: `apps/web/src/api/resources.test.ts`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/src/features/profile/ProfilePage.tsx`
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add failing API resource tests**

```ts
await scorekeeperApi.managedGames(50, 'cursor/value');
expect(fetch).toHaveBeenCalledWith(
  '/api/games/manage?limit=50&cursor=cursor%2Fvalue',
  expect.anything(),
);

await scorekeeperApi.hardDeleteGame('game/1');
expect(fetch).toHaveBeenCalledWith(
  '/api/games/game%2F1',
  expect.objectContaining({ method: 'DELETE' }),
);
```

Both responses must be validated by their contract schemas.

- [ ] **Step 2: Add failing page, permission, and single-dialog tests**

Test that only a super administrator sees `对局管理` on ProfilePage and can route to `/games/manage`. The management page must render all five Chinese status labels, time/player data, applicable `进入牌桌` or `查看历史` links, pagination, and `永久删除`.

```tsx
it('shows one destructive confirmation and deletes immediately after confirm', async () => {
  const user = userEvent.setup();
  renderManagementPage();
  await user.click(screen.getByRole('button', { name: '永久删除 测试局' }));
  expect(screen.getByRole('dialog', { name: '永久删除对局' })).toHaveTextContent(
    '购买记录、玩家锁、结算草稿、结算结果及费用分摊将一并永久删除，无法恢复。',
  );
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));
  expect(hardDeleteGame).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('再次确认')).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run focused web tests**

Run: `pnpm --filter @poker/web test -- resources.test.ts GameManagementPage.test.tsx DeleteGameDialog.test.tsx`

Expected: FAIL because resources, route, page, and dialog are absent.

- [ ] **Step 4: Implement validated resources and paged UI**

Add:

```ts
managedGames: (limit = 50, cursor?: string) => validatedApiFetch(
  managedGamesResponseSchema,
  `/games/manage?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
),
hardDeleteGame: (id: string) => validatedApiFetch(
  hardDeleteGameResponseSchema,
  `/games/${encodeURIComponent(id)}`,
  { method: 'DELETE' },
),
```

The page appends `items` only when the user presses `加载更多`, deduplicates by ID, and resets list/error state after route remount. After deletion, remove the exact item locally and show `已永久删除“对局名”`; do not refetch enough pages to infer deletion.

- [ ] **Step 5: Register and guard the route and profile entry**

```tsx
<Route path="games/manage" element={
  <RoleGate roles={['SUPER_ADMIN']}><GameManagementPage /></RoleGate>
} />
```

Only `user.role === 'SUPER_ADMIN'` renders the ProfilePage link. Server authorization remains the security boundary.

- [ ] **Step 6: Re-run and commit**

Run: `pnpm --filter @poker/web test -- resources.test.ts GameManagementPage.test.tsx DeleteGameDialog.test.tsx`

Expected: PASS.

```bash
git add apps/web/src/features/games/GameManagementPage.tsx apps/web/src/features/games/GameManagementPage.test.tsx apps/web/src/features/games/DeleteGameDialog.tsx apps/web/src/features/games/DeleteGameDialog.test.tsx apps/web/src/api/resources.ts apps/web/src/api/resources.test.ts apps/web/src/app/router.tsx apps/web/src/features/profile/ProfilePage.tsx apps/web/src/styles/global.css
git commit -m "feat: add super admin game management"
```

### Task 6: Redirect open game and settlement views when deleted

**Files:**
- Create: `apps/web/src/features/games/useGameDeletedSubscription.ts`
- Create: `apps/web/src/features/games/useGameDeletedSubscription.test.tsx`
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`
- Modify: `apps/web/src/features/settlements/SettlementWizardPage.tsx`
- Modify: `apps/web/src/features/settlements/SettlementWizardPage.test.tsx`
- Modify: `apps/web/src/features/home/HomePage.tsx`
- Modify: `apps/web/src/features/home/HomePage.test.tsx`

**Interfaces:**
- Navigation state: `{ notice: '该对局已由超级管理员删除' }`.
- The game page reuses its existing socket; settlement uses the focused deletion subscription.

- [ ] **Step 1: Add failing redirect tests for both open screens**

Emit `{ gameId, reason: 'HARD_DELETED' }` on the existing GamePage socket and on the settlement subscription socket. Each must cancel page requests/mutations, clear local game or settlement state, close its dialog, navigate to `/` with `replace: true`, and pass the exact notice.

HomePage must render the notice once, replace the same history entry without state, and not show the notice again after refresh/back navigation.

- [ ] **Step 2: Run focused tests**

Run: `pnpm --filter @poker/web test -- GamePage.test.tsx SettlementWizardPage.test.tsx useGameDeletedSubscription.test.tsx HomePage.test.tsx`

Expected: FAIL because no client handles `game.deleted`.

- [ ] **Step 3: Add the GamePage listener and settlement-only hook**

GamePage registers `game.deleted` on its existing socket and removes the listener during cleanup. `useGameDeletedSubscription` creates one socket for the settlement page, emits `game.join` with `knownVersion: 0`, listens only for the matching game ID, and disconnects on unmount. It ignores snapshot events because the settlement draft remains the page's financial source.

The redirect handler closes local modals first, aborts pending requests, and then calls:

```ts
navigate('/', {
  replace: true,
  state: { notice: '该对局已由超级管理员删除' },
});
```

- [ ] **Step 4: Render and consume the one-time home notice**

Read the location state, show an accessible status banner, then call `navigate('.', { replace: true, state: null })` after the banner is committed. Keep the displayed notice in local state so clearing history state does not remove it immediately.

- [ ] **Step 5: Re-run and commit**

Run: `pnpm --filter @poker/web test -- GamePage.test.tsx SettlementWizardPage.test.tsx useGameDeletedSubscription.test.tsx HomePage.test.tsx`

Expected: PASS.

```bash
git add apps/web/src/features/games/useGameDeletedSubscription.ts apps/web/src/features/games/useGameDeletedSubscription.test.tsx apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx apps/web/src/features/settlements/SettlementWizardPage.tsx apps/web/src/features/settlements/SettlementWizardPage.test.tsx apps/web/src/features/home/HomePage.tsx apps/web/src/features/home/HomePage.test.tsx
git commit -m "feat: exit clients from hard deleted games"
```

### Task 7: Prove destructive behavior through browser and database

**Files:**
- Create: `tests/e2e/game-hard-delete.spec.ts`
- Modify: `tests/e2e/support/database.ts`

- [ ] **Step 1: Add exact read-only database assertions for the target graph**

Create `readGameGraphCounts(gameId)` in the E2E database helper. It performs `SELECT COUNT(*)` for the eight business tables in dependency order plus the deletion audit count. It never deletes data and never accepts a name pattern as a substitute for the exact public ID.

- [ ] **Step 2: Add an active-game browser scenario**

Open the game in one authenticated page and the management page in a super-admin page. Press `永久删除`, assert exactly one dialog and the warning copy, press `确认永久删除`, then assert:

- the management row disappears;
- the live page returns home with `该对局已由超级管理员删除`;
- `readGameGraphCounts` returns zero for all eight business tables;
- one `GAME_HARD_DELETED` audit exists.

- [ ] **Step 3: Add a completed-game browser scenario**

Create/finalize a game, confirm it appears in history, hard-delete it, then assert the history route returns `NOT_FOUND`/redirect behavior, management row disappears, all settlement child counts are zero, and exactly one audit remains.

- [ ] **Step 4: Run E2E and all package checks**

Run:

```bash
pnpm test:e2e -- game-hard-delete.spec.ts
pnpm --filter @poker/contracts lint
pnpm --filter @poker/contracts typecheck
pnpm --filter @poker/contracts test
pnpm --filter @poker/api lint
pnpm --filter @poker/api typecheck
pnpm --filter @poker/api test
pnpm --filter @poker/web lint
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web test
pnpm --filter @poker/web build
```

Expected: all commands exit 0.

- [ ] **Step 5: Confirm no schema drift**

Run: `git diff --exit-code -- apps/api/prisma/schema.prisma apps/api/prisma/migrations`

Expected: exit 0 and no output.

- [ ] **Step 6: Commit the destructive-flow E2E coverage**

```bash
git add tests/e2e/game-hard-delete.spec.ts tests/e2e/support/database.ts
git commit -m "test: prove super admin hard delete cleanup"
```

## Security and Acceptance Checklist

- Normal users and administrators neither see the entry nor pass either management endpoint.
- The API revalidates the operator's enabled super-admin database row inside the delete transaction.
- All five statuses are visible and deletable.
- The UI displays exactly one irreversible confirmation with the game name, status, and child-data warning.
- The database has no target business rows and exactly one minimal hard-delete audit record.
- A deleted active player's lock is released in the same transaction.
- Concurrent buy-in/finalization cannot write after the game row is deleted.
- Online table and settlement clients exit immediately after the post-commit event.
- Presence for the deleted room is cleared while unrelated rooms remain untouched.
- No Prisma schema or migration change is introduced.
