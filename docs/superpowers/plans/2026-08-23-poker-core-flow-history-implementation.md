# Poker Core Flow, Settlement Copy, and History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace draft-first game creation and multi-confirm settlement with direct, atomic flows; simplify the home page; correct personal history money; and prefill the agreed temporary password.

**Architecture:** Keep the existing React/NestJS modular monolith, but change `POST /api/games` to create an `ACTIVE` game atomically under the lifecycle lock. Centralize money presentation in one web helper, preserve server-side preview tokens, and make the history list return the current actor's result rather than the table-wide final total.

**Tech Stack:** React 19, React Router 7, NestJS 11, Prisma 7/MariaDB, Zod 4, Vitest, Supertest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-22-poker-scorekeeper-ux-hard-delete-design.md`

## Global Constraints

- Whole-yuan money remains signed `bigint` in domain/persistence code and canonical base-10 strings in JSON.
- New game creation exposes one action, creates no new `DRAFT`, and navigates directly to the live table.
- Ending a game has one confirmation; settlement finalization has no second modal.
- Final payable/receivable amounts use absolute values; signed values use `+¥X`, `−¥X`, or `¥0`.
- Other fees remain visible only when non-zero; no financial calculation or stored field is removed.
- `12345678` is a UI default, not a server-side fixed password; `mustChangePassword=true` remains mandatory after create/reset.
- Preserve existing authorization, settlement token, draft lease, settings-version, and concurrency checks.

---

## File Structure

- Create `apps/api/src/games/game-lifecycle-coordinator.ts`: shared transaction lock used by atomic create and later hard delete.
- Create `apps/web/src/components/money-format.ts`: pure signed, unsigned, and final-result formatting.
- Create `apps/web/src/components/money-format.test.ts`: exact Unicode/currency formatting tests.
- Modify `apps/api/src/games/games.service.ts` and `games.controller.ts`: atomic create semantics while retaining legacy draft start.
- Modify `apps/api/test/games.e2e-spec.ts`: atomic create, limit/name rollback, and legacy start coverage.
- Modify `tests/e2e/support/api.ts`: stop issuing a second `/start` call.
- Modify `apps/web/src/features/games/CreateGamePage.tsx` and its test: one submit action and direct navigation.
- Modify `apps/web/src/features/games/GamePage.tsx` and its test: direct navigation after begin-settlement.
- Modify settlement components/tests: single final action and simplified money copy.
- Modify history contracts/service/page/cache/tests: actor-specific final amount.
- Modify home components/tests: current games only; remove obsolete history summary code.
- Modify user form/reset dialog/tests: shared default temporary password.
- Modify `tests/e2e/game-flow.spec.ts` and `history-aggregate.spec.ts`: user-visible flow regression.

### Task 1: Make game creation atomically ACTIVE

**Files:**
- Create: `apps/api/src/games/game-lifecycle-coordinator.ts`
- Modify: `apps/api/src/games/games.service.ts:42-121`
- Modify: `apps/api/src/games/games.controller.ts:28-54`
- Test: `apps/api/test/games.e2e-spec.ts:179-256`
- Modify: `tests/e2e/support/api.ts:43-61`

**Interfaces:**
- Produces: `lockGameLifecycleCoordinator(transaction: Prisma.TransactionClient): Promise<void>`.
- Produces: `GamesService.create(actor, input): Promise<GameSnapshotDto>` returning `status: 'ACTIVE'` with non-null `startedAt`.
- Preserves: `GamesService.start(id, actor)` for pre-existing `DRAFT` rows.

- [ ] **Step 1: Replace draft-create expectations with failing atomic-create tests**

```ts
it('creates and starts one game atomically', async () => {
  const response = await write(adminAuth, 'post', '/api/games', {
    name: `${prefix}-atomic`, handPrice: '300', rakeEnabled: true
  }).expect(201);
  expect(response.body).toMatchObject({ status: 'ACTIVE', version: 1 });
  expect(response.body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await prisma.game.count({ where: { status: GameStatus.DRAFT } })).toBe(0);
  expect(await prisma.auditLog.count({
    where: { action: 'GAME_CREATED_AND_STARTED', entityId: response.body.id }
  })).toBe(1);
});

it('leaves no game when atomic create exceeds the open-table limit', async () => {
  await seedGame(`${prefix}-open-a`, GameStatus.ACTIVE);
  await seedGame(`${prefix}-open-b`, GameStatus.SETTLING, { stoppedAt: new Date() });
  const before = await prisma.game.count();
  await write(adminAuth, 'post', '/api/games', { name: `${prefix}-rejected` })
    .expect(409).expect(({ body }) => expect(body.code).toBe('ACTIVE_GAME_LIMIT'));
  expect(await prisma.game.count()).toBe(before);
});
```

- [ ] **Step 2: Run the API tests and verify the old DRAFT behavior fails**

Run: `pnpm --filter @poker/api test:e2e -- games.e2e-spec.ts`

Expected: FAIL because `POST /api/games` returns `DRAFT` and the atomic audit action does not exist.

- [ ] **Step 3: Extract the shared lifecycle lock and implement atomic create**

```ts
// apps/api/src/games/game-lifecycle-coordinator.ts
import type { Prisma } from '../generated/prisma/client.js';

export async function lockGameLifecycleCoordinator(
  transaction: Prisma.TransactionClient
): Promise<void> {
  await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
  `;
}
```

```ts
async create(actor: AuthUser, input: CreateGameRequest): Promise<GameSnapshotDto> {
  const snapshot = await this.prisma.$transaction(async (transaction) => {
    await lockGameLifecycleCoordinator(transaction);
    const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
    const openCount = await transaction.game.count({
      where: { status: { in: [...OPEN_STATUSES] } }
    });
    if (openCount >= 2) throw conflict('ACTIVE_GAME_LIMIT');
    const now = new Date();
    const name = input.name ?? defaultShanghaiGameName(now);
    const openNames = await transaction.game.findMany({
      where: { status: { in: [...OPEN_STATUSES] } }, select: { name: true }
    });
    if (openNames.some((row) => normalizeGameName(row.name) === normalizeGameName(name))) {
      throw conflict('ACTIVE_GAME_NAME_TAKEN');
    }
    const created = await transaction.game.create({
      data: {
        name, handPrice: BigInt(input.handPrice), rakeEnabled: input.rakeEnabled,
        status: GameStatus.ACTIVE, startedAt: now, createdById: currentActor.id
      }
    });
    await this.audit.record(transaction, {
      actorUserId: currentActor.id, action: 'GAME_CREATED_AND_STARTED',
      entityType: 'GAME', entityId: created.id, before: null, after: auditGame(created)
    });
    return this.snapshotIn(transaction, created.id, now);
  });
  await this.publishSafely(snapshot.id);
  return snapshot;
}
```

Replace the private lock method in `GamesService.start` with `lockGameLifecycleCoordinator(transaction)`; do not remove legacy `start` tests.

- [ ] **Step 4: Update the Playwright API helper to consume the ACTIVE create response**

```ts
const created = await apiWrite(session, 'post', '/api/games', {
  name, handPrice, rakeEnabled: true
});
expect(created.status(), `create and start ${suffix}`).toBe(201);
const game = await created.json() as { id: string; name: string; status: string };
expect(game.status).toBe('ACTIVE');
onGameCreated?.(game.id);
return game;
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @poker/api test:e2e -- games.e2e-spec.ts`

Expected: PASS, including atomic rollback and legacy draft-start tests.

Run: `pnpm --filter @poker/api typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the atomic lifecycle change**

```powershell
git add apps/api/src/games/game-lifecycle-coordinator.ts apps/api/src/games/games.service.ts apps/api/src/games/games.controller.ts apps/api/test/games.e2e-spec.ts tests/e2e/support/api.ts
git commit -m "feat: create active games atomically"
```

### Task 2: Collapse create and end-game navigation in the web UI

**Files:**
- Modify: `apps/web/src/features/games/CreateGamePage.tsx`
- Test: `apps/web/src/features/games/CreateGamePage.test.tsx`
- Modify: `apps/web/src/features/games/GamePage.tsx:1-16,335-409`
- Test: `apps/web/src/features/games/GamePage.test.tsx:356-380`

**Interfaces:**
- Consumes: atomic `scorekeeperApi.createGame` from Task 1.
- Produces: one `创建并开启` submit flow.
- Produces: successful `beginSettlement` navigation to `/games/:id/settlement` with `replace: true`.

- [ ] **Step 1: Write failing single-action and direct-navigation tests**

```ts
it('creates one active game and navigates without a confirmation modal', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games') && init?.method === 'POST') {
      calls.push('create');
      return jsonResponse(currentGame(1));
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  renderAt('/games/new', <App />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '创建并开启' }));
  await waitFor(() => expect(window.location.pathname).toBe('/games/game-1'));
  expect(calls).toEqual(['create']);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
```

Extend the existing administrator end-game test with a settlement route and assert that clicking the single confirmation renders the settlement destination rather than an “进入结算” link.

- [ ] **Step 2: Run the two component test files and verify failure**

Run: `pnpm --filter @poker/web test -- CreateGamePage.test.tsx GamePage.test.tsx`

Expected: FAIL because two create buttons/modal still exist and `beginSettlement` does not navigate.

- [ ] **Step 3: Replace CreateGamePage state with one submit operation**

```tsx
async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!/^[1-9]\d*$/.test(handPrice)) {
    setError('每手金额必须是大于 0 的整数元');
    return;
  }
  setSubmitting(true);
  setError(null);
  try {
    const game = await scorekeeperApi.createGame({
      ...(name.trim() ? { name: name.trim() } : {}), handPrice, rakeEnabled
    });
    navigate(`/games/${encodeURIComponent(game.id)}`, { replace: true });
  } catch (reason) {
    setError(mutationMessage(reason, '创建对局失败，请稍后重试'));
  } finally {
    setSubmitting(false);
  }
}
```

Render only `<Button type="submit">{submitting ? '正在创建…' : '创建并开启'}</Button>` and remove `Intent`, `pendingGame`, `draftGame`, the draft card, and the start modal.

- [ ] **Step 4: Navigate immediately after begin-settlement succeeds**

```ts
const navigate = useNavigate();
// inside beginSettlement
const next = await scorekeeperApi.beginSettlement(snapshot.id);
if (!applySnapshot(next)) throw new Error('Invalid game snapshot');
setEndOpen(false);
navigate(`/games/${encodeURIComponent(snapshot.id)}/settlement`, { replace: true });
```

Keep the one “确认结束并进入结算” modal and remove the settling-page “进入结算” link as a normal post-action step.

- [ ] **Step 5: Run focused tests and web typecheck**

Run: `pnpm --filter @poker/web test -- CreateGamePage.test.tsx GamePage.test.tsx`

Expected: PASS.

Run: `pnpm --filter @poker/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the direct web flows**

```powershell
git add apps/web/src/features/games/CreateGamePage.tsx apps/web/src/features/games/CreateGamePage.test.tsx apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx
git commit -m "feat: streamline game creation and settlement entry"
```

### Task 3: Centralize money formatting and simplify settlement confirmation

**Files:**
- Create: `apps/web/src/components/money-format.ts`
- Create: `apps/web/src/components/money-format.test.ts`
- Modify: `apps/web/src/features/settlements/SettlementPlayerCard.tsx`
- Modify: `apps/web/src/features/settlements/SettlementBreakdown.tsx`
- Modify: `apps/web/src/features/settlements/SettlementWizardPage.tsx:102-140`
- Test: `apps/web/src/features/settlements/SettlementBreakdown.test.tsx`
- Test: `apps/web/src/features/settlements/SettlementWizardPage.test.tsx`

**Interfaces:**
- Produces: `formatSignedMoney(value: MoneyJson): string`.
- Produces: `formatUnsignedMoney(value: MoneyJson): string`.
- Produces: `finalMoneyPresentation(value: MoneyJson): { label: '最终应收' | '最终应付' | '最终收支'; amount: string; tone: MoneyTone }`.

- [ ] **Step 1: Write failing pure formatting tests**

```ts
it.each([
  ['1700', '+¥1,700'], ['-1700', '−¥1,700'], ['0', '¥0']
] as const)('formats %s as %s', (value, expected) => {
  expect(formatSignedMoney(value)).toBe(expected);
});

it('never combines payable with a negative amount', () => {
  expect(finalMoneyPresentation('-1700')).toEqual({
    label: '最终应付', amount: '¥1,700', tone: 'negative'
  });
});
```

Update wizard tests to assert one `确认结算` button, one `修改` button, no `重新生成预览`, no `打开永久确认`, and no dialog after clicking `确认结算`.

- [ ] **Step 2: Run settlement tests and verify failure**

Run: `pnpm --filter @poker/web test -- money-format.test.ts SettlementBreakdown.test.tsx SettlementWizardPage.test.tsx`

Expected: FAIL because the helper does not exist and the old confirmation modal/copy remains.

- [ ] **Step 3: Implement the pure formatter**

```ts
export function formatSignedMoney(value: MoneyJson): string {
  const parsed = BigInt(value);
  const absolute = parsed < 0n ? -parsed : parsed;
  const prefix = parsed > 0n ? '+' : parsed < 0n ? '−' : '';
  return `${prefix}¥${new Intl.NumberFormat('zh-CN').format(absolute)}`;
}

export function formatUnsignedMoney(value: MoneyJson): string {
  const parsed = BigInt(value);
  return `¥${new Intl.NumberFormat('zh-CN').format(parsed < 0n ? -parsed : parsed)}`;
}

export function finalMoneyPresentation(value: MoneyJson) {
  const parsed = BigInt(value);
  return {
    label: parsed > 0n ? '最终应收' as const : parsed < 0n ? '最终应付' as const : '最终收支' as const,
    amount: formatUnsignedMoney(value),
    tone: parsed > 0n ? 'positive' as const : parsed < 0n ? 'negative' as const : 'neutral' as const
  };
}
```

- [ ] **Step 4: Render only the agreed settlement levels**

Use `本局输赢`, `房费`, conditional `其他费用`, `抽成`, and the final presentation. Remove `settlementLabel`, `metric-sign`, duplicated parenthesized signed values, and intermediate “费用后盈亏” UI. Preserve the underlying DTO fields and server calculation tests.

```tsx
const final = finalMoneyPresentation(player.finalAmount);
<dl className="settlement-metrics settlement-metrics--simple">
  <MoneyText label="本局输赢" value={formatSignedMoney(player.rawProfit)} />
  <MoneyText label="房费" value={formatUnsignedMoney(player.roomFeeShare)} tone="expense" />
  {BigInt(player.otherFeeShare) !== 0n &&
    <MoneyText label="其他费用" value={formatUnsignedMoney(player.otherFeeShare)} tone="expense" />}
  <MoneyText label="抽成" value={formatUnsignedMoney(player.rakeAmount)} tone="rake" />
  <MoneyText label={final.label} value={final.amount} tone={final.tone} final />
</dl>
```

- [ ] **Step 5: Remove the second settlement modal without weakening token checks**

Delete `confirmOpen` state and the `<Modal title="确认永久结算">`. On the preview step render:

```tsx
<SettlementBreakdown breakdown={preview} mode="preview" />
<p className="irreversible-note">确认后本局结算将永久锁定，无法在页面中修改。</p>
<div className="inline-actions">
  <Button variant="ghost" disabled={finalizing} onClick={() => setStep('expense')}>修改</Button>
  <Button variant="danger" unsafe disabled={!previewCanConfirm || finalizing} onClick={() => void finalize()}>
    {finalizing ? '正在结算…' : '确认结算'}
  </Button>
</div>
```

Keep `sameBinding`, `draftVersion`, `settingsVersion`, `confirmationToken`, abort handling, and the `SETTINGS_VERSION_CONFLICT` return-to-expense behavior.

- [ ] **Step 6: Run focused settlement tests and typecheck**

Run: `pnpm --filter @poker/web test -- money-format.test.ts SettlementBreakdown.test.tsx SettlementWizardPage.test.tsx`

Expected: PASS.

Run: `pnpm --filter @poker/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit settlement copy and interaction**

```powershell
git add apps/web/src/components/money-format.ts apps/web/src/components/money-format.test.ts apps/web/src/features/settlements/SettlementPlayerCard.tsx apps/web/src/features/settlements/SettlementBreakdown.tsx apps/web/src/features/settlements/SettlementWizardPage.tsx apps/web/src/features/settlements/SettlementBreakdown.test.tsx apps/web/src/features/settlements/SettlementWizardPage.test.tsx
git commit -m "feat: simplify settlement confirmation and money copy"
```

### Task 4: Remove home history and return actor-specific history amounts

**Files:**
- Modify: `packages/contracts/src/history.ts:22-45`
- Test: `packages/contracts/src/history.test.ts`
- Modify: `apps/api/src/history/history.service.ts:26-61`
- Test: `apps/api/test/history.e2e-spec.ts:240-359`
- Modify: `apps/web/src/features/history/HistoryPage.tsx`
- Modify: `apps/web/src/features/history/history-cache.ts`
- Test: `apps/web/src/features/history/HistoryPage.test.tsx`
- Modify: `apps/web/src/features/home/HomePage.tsx`
- Test: `apps/web/src/features/home/HomePage.test.tsx`
- Modify: `apps/web/src/api/resources.ts:31-44,78-89`
- Delete: `apps/web/src/features/home/RecentResultRow.tsx`

**Interfaces:**
- Produces: `HistoryListItemDto.myFinalAmount: MoneyJson | null`.
- Removes: obsolete `HistoryGameSummary`, `HistoryListResponse`, and `scorekeeperApi.recentHistory`.
- Preserves: cursor pagination and full-table immutable history detail.

- [ ] **Step 1: Write failing contract and API tests for personal money**

```ts
expect(historyListItemSchema.parse({
  gameId: 'game-1', name: '测试', completedAt: '2026-08-18T12:00:00.000+08:00',
  settledByNickname: '管理员', myFinalAmount: '-1700'
}).myFinalAmount).toBe('-1700');
```

In `history.e2e-spec.ts`, assert the participating member receives their seeded `SettlementResult.finalAmount`, while an administrator who did not participate receives `myFinalAmount: null` for the same row.

- [ ] **Step 2: Run contract/API tests and verify failure**

Run: `pnpm --filter @poker/contracts test -- history.test.ts`

Expected: FAIL because the schema still requires `final`.

Run: `pnpm --filter @poker/api test:e2e -- history.e2e-spec.ts`

Expected: FAIL because `HistoryService.list` returns table `finalTotal`.

- [ ] **Step 3: Change the shared history list contract**

```ts
export const historyListItemSchema = z.object({
  gameId: canonicalPublicIdSchema,
  name: z.string().min(1).max(128),
  completedAt: offsetDateTimeSchema,
  settledByNickname: z.string().min(1).max(64),
  myFinalAmount: moneyJsonSchema.nullable()
}).strict();
```

- [ ] **Step 4: Map the current actor's SettlementResult in HistoryService**

Change the list include to load result `finalAmount` with `gamePlayer.userId`. Map each row with:

```ts
const ownResult = game.settlement!.results.find(
  ({ gamePlayer }) => gamePlayer.userId === actor.id
);
return {
  gameId: game.id,
  name: game.name,
  completedAt: game.completedAt!.toISOString(),
  settledByNickname: game.settlement!.settledByNicknameSnapshot,
  myFinalAmount: ownResult === undefined ? null : formatMoney(ownResult.finalAmount)
};
```

Do not change `historyScope(actor)`: ordinary users still see only participated games; administrators retain global scope.

- [ ] **Step 5: Simplify HomePage and remove the obsolete API shape**

Remove all history state/effects and render only the current-games section. Delete `RecentResultRow.tsx`, `HistoryGameSummary`, `HistoryListResponse`, and `scorekeeperApi.recentHistory`. Replace HomePage tests with assertions that only `/api/games/current` is requested and neither “个人摘要” nor “最近战绩” exists.

- [ ] **Step 6: Render personal history money with the central formatter**

```tsx
<strong className="result-amount">
  {item.myFinalAmount === null ? '查看明细' : formatSignedMoney(item.myFinalAmount)}
</strong>
```

Bump the list cache key from `history-cache:v1` to `history-cache:v2` so old `{ final }` rows cannot be rendered under the new schema.

- [ ] **Step 7: Run focused contract, API, and web tests**

Run: `pnpm --filter @poker/contracts test -- history.test.ts`

Expected: PASS.

Run: `pnpm --filter @poker/api test:e2e -- history.e2e-spec.ts`

Expected: PASS.

Run: `pnpm --filter @poker/web test -- HomePage.test.tsx HistoryPage.test.tsx`

Expected: PASS with no home history request and `−¥` formatting.

- [ ] **Step 8: Commit home/history contract alignment**

```powershell
git add packages/contracts/src/history.ts packages/contracts/src/history.test.ts apps/api/src/history/history.service.ts apps/api/test/history.e2e-spec.ts apps/web/src/features/history/HistoryPage.tsx apps/web/src/features/history/HistoryPage.test.tsx apps/web/src/features/history/history-cache.ts apps/web/src/features/home/HomePage.tsx apps/web/src/features/home/HomePage.test.tsx apps/web/src/api/resources.ts
git rm apps/web/src/features/home/RecentResultRow.tsx
git commit -m "fix: align personal history results"
```

### Task 5: Prefill the agreed temporary password

**Files:**
- Create: `apps/web/src/features/users/default-temporary-password.ts`
- Modify: `apps/web/src/features/users/UserFormPage.tsx:14-27`
- Modify: `apps/web/src/features/users/ResetPasswordDialog.tsx:7-14`
- Modify: `apps/web/src/features/users/UserFormPage.test.tsx`
- Create: `apps/web/src/features/users/ResetPasswordDialog.test.tsx`

**Interfaces:**
- Produces: `DEFAULT_TEMPORARY_PASSWORD = '12345678'`.
- Preserves: editable password inputs and server-enforced 8–128 length.

- [ ] **Step 1: Write failing prefill tests**

```ts
it('prefills the agreed temporary password when creating a user', async () => {
  renderAt('/users/new', <App />);
  expect(await screen.findByLabelText('初始密码')).toHaveValue('12345678');
});

it('prefills the agreed temporary password when resetting a user', () => {
  render(<ResetPasswordDialog user={targetUser} onClose={vi.fn()} onReset={vi.fn()} />);
  expect(screen.getByLabelText('新临时密码')).toHaveValue('12345678');
});
```

- [ ] **Step 2: Run the user form test and verify failure**

Run: `pnpm --filter @poker/web test -- UserFormPage.test.tsx ResetPasswordDialog.test.tsx`

Expected: FAIL because both initial states are empty strings.

- [ ] **Step 3: Add and consume the shared constant**

Create and export a shared `DEFAULT_TEMPORARY_PASSWORD` constant using the
agreed `12345678` initial value.

Initialize `initialPassword` and reset-dialog `password` from the constant. After a successful reset, close through the existing completed state; do not silently submit on dialog open.

- [ ] **Step 4: Run user tests and verify forced-change server coverage remains green**

Run: `pnpm --filter @poker/web test -- UserFormPage.test.tsx ResetPasswordDialog.test.tsx`

Expected: PASS.

Run: `pnpm --filter @poker/api test:e2e -- users.e2e-spec.ts auth.e2e-spec.ts`

Expected: PASS, including `mustChangePassword=true` and session revocation.

- [ ] **Step 5: Commit the temporary-password defaults**

```powershell
git add apps/web/src/features/users/default-temporary-password.ts apps/web/src/features/users/UserFormPage.tsx apps/web/src/features/users/ResetPasswordDialog.tsx apps/web/src/features/users/UserFormPage.test.tsx apps/web/src/features/users/ResetPasswordDialog.test.tsx
git commit -m "feat: prefill temporary user passwords"
```

### Task 6: Verify the complete core flow

**Files:**
- Modify: `tests/e2e/game-flow.spec.ts`
- Modify: `tests/e2e/history-aggregate.spec.ts`
- Modify: only source/test files required by failures found in this task.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: one browser-level regression covering create, end, single-confirm finalization, and personal history formatting.

- [ ] **Step 1: Update browser assertions to the confirmed flow**

Assert that the create page has one `创建并开启` button, end confirmation navigates directly to settlement, the preview has only `修改` and `确认结算`, and the finalized participant history row contains `−¥` or `+¥` according to the seeded result.

```ts
await expect(page.getByRole('button', { name: '创建并开启' })).toHaveCount(1);
await expect(page.getByRole('button', { name: '创建草稿' })).toHaveCount(0);
await page.getByRole('button', { name: '确认结束并进入结算' }).click();
await expect(page).toHaveURL(new RegExp(`/games/${gameId}/settlement$`));
await expect(page.getByRole('button', { name: '确认结算' })).toBeVisible();
await expect(page.getByRole('button', { name: '重新生成预览' })).toHaveCount(0);
```

- [ ] **Step 2: Run the two Playwright specs**

Run: `pnpm exec playwright test tests/e2e/game-flow.spec.ts tests/e2e/history-aggregate.spec.ts`

Expected: PASS on configured mobile and desktop projects.

- [ ] **Step 3: Run package-wide verification**

Run: `pnpm test`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm lint`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 4: Commit browser-flow adjustments**

```powershell
git add tests/e2e/game-flow.spec.ts tests/e2e/history-aggregate.spec.ts
git commit -m "test: cover streamlined poker flows"
```
