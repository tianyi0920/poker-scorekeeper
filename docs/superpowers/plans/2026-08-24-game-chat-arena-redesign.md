# Game Chat and Arena Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved compact mobile game page with a realistic portrait poker table and current-game-only text messages stored exclusively in API process memory.

**Architecture:** Add strict shared message contracts, a focused `GameMessagesService` backed by `Map<gameId, GameMessageDto[]>`, REST read/write endpoints, and one authorized Socket.IO broadcast event. The web page loads messages separately from financial game snapshots, receives live additions, falls back to the existing ten-second poller, and renders three tabs plus a small speech sheet. Lifecycle services clear only the target game's memory after settlement, void, or hard-delete commits.

**Tech Stack:** TypeScript, Zod 4, NestJS 11, Socket.IO 4, React 19, Vitest, Testing Library, CSS safe-area/dynamic viewport rules.

**Spec:** `docs/superpowers/specs/2026-08-24-game-chat-arena-redesign.md`

## Global Constraints

- Do not modify `apps/api/prisma/schema.prisma`, create a migration, or write messages to MariaDB.
- Keep at most the latest 50 messages per active game in API process memory.
- Clear a game's messages after committed `ACTIVE → SETTLING`, `ACTIVE → VOIDED`, or hard delete; service restart may clear all messages.
- Accept trimmed text of 1 through 120 characters without control characters.
- Do not add unread counts, notifications, typing status, media, reply, edit, recall, search, moderation, or cross-game history.
- Preserve current HTTPS/WSS, session, CSRF, game-view authorization, and ten-second degraded-sync behavior.
- Preserve the existing administrator-only “结束对局” confirmation and immediate settlement navigation; ordinary users must not see this action.
- Keep all user-facing text Chinese and preserve iPhone `safe-area-inset-top` / `safe-area-inset-bottom` handling.

---

### Task 1: Define strict message contracts

**Files:**
- Create: `packages/contracts/src/game-messages.ts`
- Create: `packages/contracts/src/game-messages.test.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Modify: `packages/contracts/src/realtime.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `gameMessageTextSchema`, `createGameMessageRequestSchema`, `gameMessageSchema`, `gameMessagesResponseSchema`.
- Produces: `CreateGameMessageRequest`, `GameMessageDto`, `GameMessagesResponseDto`.
- Produces: `gameMessageCreatedEventSchema` and `GameMessageCreatedEvent`.

- [ ] **Step 1: Write the failing contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  createGameMessageRequestSchema,
  gameMessageSchema,
  gameMessagesResponseSchema
} from './game-messages.js';

const message = {
  id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
  gameId: 'cm123abc',
  userId: 'cm456def',
  nickname: '西西',
  avatarUrl: '/avatars/preset-13.webp',
  text: '马上到',
  createdAt: '2026-08-24T09:00:00.000Z'
};

describe('game message contracts', () => {
  it('trims and accepts one current-game message', () => {
    expect(createGameMessageRequestSchema.parse({ text: '  马上到  ' })).toEqual({ text: '马上到' });
    expect(gameMessageSchema.parse(message)).toEqual(message);
    expect(gameMessagesResponseSchema.parse({ gameId: 'cm123abc', messages: [message] }).messages).toHaveLength(1);
  });

  it.each([{ text: '' }, { text: ' '.repeat(4) }, { text: 'a'.repeat(121) }, { text: 'a\u0000b' }])(
    'rejects invalid text %#',
    (input) => expect(createGameMessageRequestSchema.safeParse(input).success).toBe(false)
  );
});
```

Extend `realtime.test.ts` with a valid `game.message.created` event and strict rejection of an extra property.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm --filter @poker/contracts test -- game-messages.test.ts realtime.test.ts
```

Expected: FAIL because `game-messages.ts` and `gameMessageCreatedEventSchema` do not exist.

- [ ] **Step 3: Implement the contracts**

```ts
import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

export const gameMessageTextSchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !hasControlCharacter(value));

export const createGameMessageRequestSchema = z.object({ text: gameMessageTextSchema }).strict();
export const gameMessageSchema = z.object({
  id: z.uuid(),
  gameId: canonicalPublicIdSchema,
  userId: canonicalPublicIdSchema,
  nickname: z.string().min(1),
  avatarUrl: z.string().min(1),
  text: gameMessageTextSchema,
  createdAt: z.iso.datetime({ offset: true })
}).strict();
export const gameMessagesResponseSchema = z.object({
  gameId: canonicalPublicIdSchema,
  messages: z.array(gameMessageSchema).max(50)
}).strict();

export type CreateGameMessageRequest = z.infer<typeof createGameMessageRequestSchema>;
export type GameMessageDto = z.infer<typeof gameMessageSchema>;
export type GameMessagesResponseDto = z.infer<typeof gameMessagesResponseSchema>;
```

In `realtime.ts`, define `gameMessageCreatedEventSchema = gameMessageSchema` and export its inferred type. Export `./game-messages.js` from `index.ts`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @poker/contracts test -- game-messages.test.ts realtime.test.ts
pnpm --filter @poker/contracts typecheck
```

Expected: all focused contract tests and typecheck pass.

- [ ] **Step 5: Commit the contract**

```powershell
git add packages/contracts/src/game-messages.ts packages/contracts/src/game-messages.test.ts packages/contracts/src/realtime.ts packages/contracts/src/realtime.test.ts packages/contracts/src/index.ts
git commit -m "feat: define current-game message contracts"
```

---

### Task 2: Add the bounded in-memory message service and REST endpoints

**Files:**
- Create: `apps/api/src/games/game-messages.service.ts`
- Create: `apps/api/src/games/game-messages.service.test.ts`
- Modify: `apps/api/src/games/games.module.ts`
- Modify: `apps/api/src/games/games.controller.ts`
- Modify: `apps/api/src/realtime/game-events.service.ts`
- Modify: `apps/api/src/realtime/game-events.service.test.ts`
- Modify: `apps/api/test/games.e2e-spec.ts`

**Interfaces:**
- Consumes: `CreateGameMessageRequest`, `GameMessageDto`, `GameMessagesResponseDto` from Task 1.
- Produces: `GameMessagesService.list(gameId, actor)`, `create(gameId, actor, input)`, and `clear(gameId)`.
- Produces: `GameEventsService.publishGameMessage(gameId: string, message: GameMessageDto): Promise<void>`.
- Produces: `GET /api/games/:id/messages` and `POST /api/games/:id/messages`.

- [ ] **Step 1: Write failing unit tests for memory behavior**

Create a fixture whose Prisma `game.findUnique` returns an `ACTIVE` game with `players`, and whose events stub records `publishGameMessage` calls. Cover:

```ts
it('stores and returns an authorized active-game message', async () => {
  const created = await service.create('cm123abc', actor, { text: '  马上到  ' });
  expect(created.text).toBe('马上到');
  expect((await service.list('cm123abc', actor)).messages).toEqual([created]);
  expect(events.publishGameMessage).toHaveBeenCalledWith('cm123abc', created);
});

it('keeps only the latest fifty messages per game', async () => {
  for (let index = 0; index < 51; index += 1) {
    await service.create('cm123abc', actor, { text: `消息${index}` });
  }
  const messages = (await service.list('cm123abc', actor)).messages;
  expect(messages).toHaveLength(50);
  expect(messages[0]?.text).toBe('消息1');
  expect(messages.at(-1)?.text).toBe('消息50');
});

it('isolates and clears only the requested game', async () => {
  await service.create('cm123abc', actor, { text: '第一桌' });
  await service.create('cm999xyz', actor, { text: '第二桌' });
  service.clear('cm123abc');
  expect((await service.list('cm123abc', actor)).messages).toEqual([]);
  expect((await service.list('cm999xyz', actor)).messages).toHaveLength(1);
});
```

Also cover `NOT_FOUND`, `FORBIDDEN`, non-`ACTIVE` create returning `GAME_STATE_CONFLICT`, and current avatar URL formatting for preset/upload avatars.

Add a failing `game-events.service.test.ts` case with one valid target-room socket, one revoked target-room socket, and one unrelated socket:

```ts
it('publishes a message only to still-authorized sockets in the target room', async () => {
  const message = gameMessage();
  await service.publishGameMessage('game-1', message);
  expect(valid.emit).toHaveBeenCalledExactlyOnceWith('game.message.created', message);
  expect(unrelated.emit).not.toHaveBeenCalled();
  expect(revoked.emit).toHaveBeenCalledWith('server.error', { code: 'FORBIDDEN' });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```powershell
pnpm --filter @poker/contracts build
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/games/game-messages.service.test.ts src/realtime/game-events.service.test.ts
```

Expected: FAIL because `GameMessagesService` and `publishGameMessage` do not exist.

- [ ] **Step 3: Implement the authorized publisher and minimal service**

Add the publisher to `GameEventsService` and reuse its existing authorization loop:

```ts
async publishGameMessage(gameId: string, message: GameMessageDto): Promise<void> {
  const game = await this.prisma.game.findUnique({ where: { id: gameId }, include: snapshotInclude });
  if (game === null || game.status !== GameStatus.ACTIVE) return;
  await this.forEachAuthorizedSocket(gameId, game, (socket) => {
    socket.emit('game.message.created', message);
  });
}
```

Use one private map and one authorization load:

```ts
@Injectable()
export class GameMessagesService {
  private readonly messagesByGame = new Map<string, GameMessageDto[]>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  async list(gameId: string, actor: AuthUser): Promise<GameMessagesResponseDto> {
    const game = await this.authorizedGame(gameId, actor);
    return { gameId, messages: game.status === GameStatus.ACTIVE ? [...(this.messagesByGame.get(gameId) ?? [])] : [] };
  }

  async create(gameId: string, actor: AuthUser, input: CreateGameMessageRequest): Promise<GameMessageDto> {
    const game = await this.authorizedGame(gameId, actor);
    if (game.status !== GameStatus.ACTIVE) throw conflict('GAME_STATE_CONFLICT');
    const message: GameMessageDto = {
      id: randomUUID(),
      gameId,
      userId: actor.id,
      nickname: actor.nickname,
      avatarUrl: actor.avatarKind === 'PRESET' ? `/avatars/${actor.avatarValue}.webp` : `/avatars/uploads/${actor.avatarValue}`,
      text: input.text,
      createdAt: new Date().toISOString()
    };
    const next = [...(this.messagesByGame.get(gameId) ?? []), message].slice(-50);
    this.messagesByGame.set(gameId, next);
    await this.events.publishGameMessage(gameId, message).catch(() => undefined);
    return message;
  }

  clear(gameId: string): void {
    this.messagesByGame.delete(gameId);
  }
}
```

`authorizedGame` loads `{ status, players: { select: { userId: true } } }`, throws `NOT_FOUND`, and calls `assertCanViewGameSnapshot(actor, game)`.

- [ ] **Step 4: Expose strict controller endpoints**

Register `GameMessagesService` in `GamesModule`. Inject it into `GamesController` and add:

```ts
@Get(':id/messages')
messages(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<GameMessagesResponseDto> {
  return this.gameMessages.list(id, actor);
}

@Post(':id/messages')
@HttpCode(201)
createMessage(
  @CurrentUser() actor: AuthUser,
  @Param('id') id: string,
  @Body(new ZodValidationPipe(createGameMessageRequestSchema)) body: CreateGameMessageRequest
): Promise<GameMessageDto> {
  return this.gameMessages.create(id, actor, body);
}
```

Add E2E cases for authenticated GET/POST, invalid text, non-active send, and another game ID. Do not add any Prisma model or migration setup.

- [ ] **Step 5: Run focused API tests and verify GREEN**

Run:

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/games/game-messages.service.test.ts
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/realtime/game-events.service.test.ts
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/games.e2e-spec.ts
```

Expected: focused unit and E2E tests pass.

- [ ] **Step 6: Commit the service and endpoints**

```powershell
git add apps/api/src/games/game-messages.service.ts apps/api/src/games/game-messages.service.test.ts apps/api/src/games/games.module.ts apps/api/src/games/games.controller.ts apps/api/src/realtime/game-events.service.ts apps/api/src/realtime/game-events.service.test.ts apps/api/test/games.e2e-spec.ts
git commit -m "feat: add in-memory game messages"
```

---

### Task 3: Clear message memory at lifecycle boundaries

**Files:**
- Modify: `apps/api/src/games/games.service.ts`
- Modify: `apps/api/src/games/game-management.service.ts`
- Modify: `apps/api/src/games/game-management.service.test.ts`
- Modify: `apps/api/test/games.e2e-spec.ts`

**Interfaces:**
- Consumes: `GameMessageDto` and `GameMessagesService.clear(gameId)`.
- [ ] **Step 1: Write failing cleanup tests**

Add assertions that:

- a failed transaction never calls `clear`;
- successful `beginSettlement` calls `clear(id)` before publishing the committed snapshot;
- successful `void` calls `clear(id)`;
- successful hard delete calls `clear(id)` even when the deletion broadcast throws;
- clearing one ID does not clear another (already covered by the service test).

- [ ] **Step 2: Implement cleanup after commits**

Inject `GameMessagesService` into `GamesService` and `GameManagementService`. After the database transaction resolves:

```ts
this.gameMessages.clear(id);
await this.publishSafely(id);
```

Use that order for `beginSettlement` and `void`. In `hardDelete`, call `clear(id)` immediately after the transaction and before the best-effort `publishDeletedGame` block. Do not clear in transaction callbacks.

- [ ] **Step 3: Run focused cleanup tests**

Run:

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts src/games/game-messages.service.test.ts src/games/game-management.service.test.ts
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/games.e2e-spec.ts
```

Expected: all focused tests pass.

- [ ] **Step 4: Commit lifecycle behavior**

```powershell
git add apps/api/src/games/games.service.ts apps/api/src/games/game-management.service.ts apps/api/src/games/game-management.service.test.ts apps/api/test/games.e2e-spec.ts
git commit -m "feat: clear messages when games end"
```

---

### Task 4: Add the minimal web message flow

**Files:**
- Create: `apps/web/src/features/games/GameMessagesPanel.tsx`
- Create: `apps/web/src/features/games/GameSpeechSheet.tsx`
- Modify: `apps/web/src/api/resources.ts`
- Modify: `apps/web/src/api/resources.test.ts`
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`

**Interfaces:**
- Consumes: `GameMessageDto`, `GameMessagesResponseDto`, `gameMessageCreatedEventSchema`, and Task 2 REST endpoints.
- Produces: `scorekeeperApi.gameMessages(gameId, signal?)` and `scorekeeperApi.createGameMessage(gameId, body, signal?)`.
- Produces: `GameMessagesPanel` and `GameSpeechSheet`.

- [ ] **Step 1: Write failing API-client tests**

Add strict response validation and encoded paths:

```ts
await scorekeeperApi.gameMessages('game/1');
expect(fetchMock).toHaveBeenCalledWith('/games/game%2F1/messages', expect.any(Object));

await scorekeeperApi.createGameMessage('game/1', { text: '马上到' });
expect(fetchMock).toHaveBeenCalledWith('/games/game%2F1/messages', expect.objectContaining({
  method: 'POST',
  body: JSON.stringify({ text: '马上到' })
}));
```

Also reject a malformed response/event instead of rendering arbitrary server fields.

- [ ] **Step 2: Write failing `GamePage` interaction tests**

Cover these user-visible behaviors:

```ts
expect(screen.getByRole('tab', { name: '竞技区' })).toHaveAttribute('aria-selected', 'true');
expect(screen.getByRole('tab', { name: '购买记录' })).toBeInTheDocument();
expect(screen.getByRole('tab', { name: '消息区' })).toBeInTheDocument();

await user.click(screen.getByRole('button', { name: '发言' }));
expect(screen.getByRole('dialog', { name: '发言' })).toBeInTheDocument();
await user.type(screen.getByRole('textbox', { name: '发言内容' }), '马上到');
await user.click(screen.getByRole('button', { name: '发送' }));
expect(fetchMock).toHaveReceivedPost('/api/games/game-1/messages', { text: '马上到' });
```

Also test:

- successful send closes the sheet and adds the message once;
- failed send keeps the text and offers a Chinese retry message;
- `game.message.created` for the current game adds once, while malformed/other-game events are ignored;
- opening “消息区” shows ordered current messages and no unread badge;
- when Socket polling fallback is active, a ten-second cycle re-reads both snapshot and messages;
- settlement closes the speech sheet and removes the send button;
- route change resets messages from the previous game.

- [ ] **Step 3: Run web tests and verify RED**

Run:

```powershell
pnpm --filter @poker/contracts build
pnpm --filter @poker/web test -- resources.test.ts GamePage.test.tsx
```

Expected: FAIL because message APIs, third tab, sheet, and event handler do not exist.

- [ ] **Step 4: Implement strict API helpers**

Use `validatedApiFetch`:

```ts
gameMessages: (gameId: string, signal?: AbortSignal) => validatedApiFetch(
  gameMessagesResponseSchema,
  `/games/${encodeURIComponent(gameId)}/messages`,
  { signal }
),
createGameMessage: (gameId: string, body: CreateGameMessageRequest, signal?: AbortSignal) => validatedApiFetch(
  gameMessageSchema,
  `/games/${encodeURIComponent(gameId)}/messages`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
)
```

- [ ] **Step 5: Implement focused message components**

`GameMessagesPanel` accepts `messages: GameMessageDto[]` and renders avatar, nickname, text, and a Chinese relative timestamp. `GameSpeechSheet` accepts `open`, `disabled`, `submitting`, `error`, `onClose`, and `onSubmit(text)`; it owns the draft so a failed send retains it and clears only after success.

- [ ] **Step 6: Integrate message state into `GamePage`**

Add `tab: 'arena' | 'purchases' | 'messages'`, `messages`, and `speechOpen`. On initial load call `gameSnapshot` and `gameMessages`. Register `game.message.created` beside existing Socket listeners, validate with `gameMessageCreatedEventSchema`, deduplicate by `id`, and cap client state to 50. In the existing fallback interval, call both readers. Clear state on route cleanup and any non-`ACTIVE` snapshot.

The arena receives only `messages.at(-1)` for the latest speech bubble; the full list goes only to `GameMessagesPanel`.

- [ ] **Step 7: Run focused web tests and verify GREEN**

Run:

```powershell
pnpm --filter @poker/web test -- resources.test.ts GamePage.test.tsx
pnpm --filter @poker/web typecheck
```

Expected: focused web tests and typecheck pass.

- [ ] **Step 8: Commit the web message flow**

```powershell
git add apps/web/src/api/resources.ts apps/web/src/api/resources.test.ts apps/web/src/features/games/GameMessagesPanel.tsx apps/web/src/features/games/GameSpeechSheet.tsx apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx
git commit -m "feat: add current-game message UI"
```

---

### Task 5: Rebuild the mobile arena around the portrait poker table

**Files:**
- Modify: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/src/app/AppShell.test.tsx`
- Modify: `apps/web/src/features/games/GamePage.tsx`
- Modify: `apps/web/src/features/games/RoundTable.tsx`
- Modify: `apps/web/src/features/games/RoundTable.test.tsx`
- Modify: `apps/web/src/features/games/Seat.tsx`
- Modify: `apps/web/src/features/games/SpectatorBar.tsx`
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/features/games/GamePage.test.tsx`

**Interfaces:**
- Consumes: latest `GameMessageDto | undefined` from Task 4.
- Produces: `RoundTable` support for `latestMessage` and the approved compact three-tab mobile layout.

- [ ] **Step 1: Write failing structural and responsive tests**

Update component tests to require:

- `RoundTable` renders a portrait arena class and five community-card slots;
- only the latest message is associated with the matching player `userId`;
- spectator strip precedes the table in DOM order;
- the live game shell exposes a compact header class without changing settlement/history shells;
- the bottom action region contains “购买筹码” and “发言” and no unread marker;
- administrators still see “结束对局” beside the game status, ordinary users do not, and its confirmed success still navigates directly to settlement;
- the CSS source includes `100dvh`, `safe-area-inset-bottom`, three equal game tabs, and mobile arena rules at 320/420px boundaries.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm --filter @poker/web test -- AppShell.test.tsx RoundTable.test.tsx GamePage.test.tsx
```

Expected: FAIL against the current horizontal oval, two tabs, large header, and one-button dock.

- [ ] **Step 3: Implement compact live-game chrome**

For `isLiveGameRoute`, render the same semantic app header and welcome content with live-game modifier classes so CSS can collapse them into one compact row. Do not remove the logout action, the administrator-only end-game action, its confirmation dialog, or its immediate settlement navigation; do not alter non-game pages.

- [ ] **Step 4: Implement the portrait table structure**

Keep seat ordering and self-at-bottom rotation. Change the arena geometry to a portrait ellipse and render:

```tsx
<div className="poker-felt" aria-hidden="true">
  <span className="felt-betting-line" />
  <span className="felt-center-line felt-center-line--vertical" />
  <span className="felt-center-line felt-center-line--horizontal" />
  <span className="community-card-slots">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</span>
</div>
```

Pass the latest message to the matching `Seat`, where one `.seat-speech` bubble is rendered next to that avatar. If the sender is only a spectator, render one compact bubble in `SpectatorBar` instead.

- [ ] **Step 5: Implement responsive CSS from the approved preview**

Use the remaining dynamic viewport rather than fixed sparse/standard/full heights:

```css
.app-shell--game { min-height: 100dvh; padding-top: max(8px, var(--safe-top)); }
.app-shell--game .app-header { min-height: 28px; }
.game-page { min-height: calc(100dvh - var(--safe-top)); gap: 7px; }
.game-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.battle-panel { display: grid; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); }
.round-table { min-height: clamp(29rem, 62dvh, 36rem); }
.poker-felt { width: min(83%, 294px); height: calc(100% - 58px); border-radius: 48% / 24%; }
.game-action-dock { padding-bottom: calc(8px + var(--safe-bottom)); }
```

Preserve readable 44px actions. At `max-width: 420px` shrink chrome and seat labels before shrinking the table; at `max-width: 359px` keep the observer strip and dock visible without horizontal overflow.

- [ ] **Step 6: Run focused page tests and build**

Run:

```powershell
pnpm --filter @poker/web test -- AppShell.test.tsx RoundTable.test.tsx GamePage.test.tsx
pnpm --filter @poker/web build
```

Expected: focused tests and production web build pass.

- [ ] **Step 7: Commit the arena redesign**

```powershell
git add apps/web/src/app/AppShell.tsx apps/web/src/app/AppShell.test.tsx apps/web/src/features/games/GamePage.tsx apps/web/src/features/games/GamePage.test.tsx apps/web/src/features/games/RoundTable.tsx apps/web/src/features/games/RoundTable.test.tsx apps/web/src/features/games/Seat.tsx apps/web/src/features/games/SpectatorBar.tsx apps/web/src/styles/global.css
git commit -m "feat: expand the mobile poker arena"
```

---

### Task 6: Prove no database change and complete release-level verification

**Files:**
- Verify only; no expected source files.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verification evidence and a clean feature branch ready for review.

- [ ] **Step 1: Prove the database surface is unchanged**

Run:

```powershell
git diff master...HEAD -- apps/api/prisma/schema.prisma apps/api/prisma/migrations
```

Expected: no output.

- [ ] **Step 2: Run all tests**

Run from an environment with the repository's expected Node 24, `BASH_PATH`, and child-only `DATABASE_URL` injection:

```powershell
pnpm test
```

Expected: contracts, settlement, web, API unit, and API E2E suites pass; only pre-existing documented skips may remain.

- [ ] **Step 3: Run static and production checks**

```powershell
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit zero and `git diff --check` reports no whitespace errors.

- [ ] **Step 4: Inspect the mobile workflow**

At widths 320px, the user's current iPhone viewport, and 640px, verify:

1. The compact header, three tabs, four facts, observer strip, portrait table, and safe-area dock fit without horizontal clipping.
2. “发言” opens the small bottom sheet; failed send retains the text; successful send closes it.
3. The newest message appears once beside the sender and in “消息区”.
4. Ending the game removes the send action and a subsequent message read is empty.

- [ ] **Step 5: Review branch contents**

```powershell
git status --short --branch
git log --oneline master..HEAD
git diff --stat master...HEAD
```

Expected: only the approved design, plan, contracts, in-memory API/realtime code, and mobile web changes are present.
