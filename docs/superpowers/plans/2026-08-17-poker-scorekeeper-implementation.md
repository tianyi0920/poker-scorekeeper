# Poker Scorekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the approved mobile-first, multi-user offline poker scorekeeper with immutable MySQL settlement records on Synology Docker.

**Architecture:** Use a pnpm workspace with a React PWA, a modular NestJS API, shared Zod contracts, and a pure settlement package. Build the React assets first and serve them from the same NestJS container; use Prisma 7 with MySQL, Socket.IO rooms for live tables, and a NAS volume for avatars.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.4+, pnpm 10, React 19.2, Vite 7, React Router, TanStack Query, Socket.IO, NestJS 11, Prisma 7 with `@prisma/adapter-mariadb`, MySQL, Zod, Argon2id, Sharp, Vitest, Supertest, Testing Library, Playwright, Docker Compose.

**Approved design:** `docs/superpowers/specs/2026-08-17-poker-scorekeeper-design.md`

## Global Constraints

- All displayed and stored money is whole yuan. Domain and persistence code use `bigint`; JSON APIs use base-10 integer strings.
- Default hand price is `300`, room fee is `380`, other fee is `0`, rake threshold is `1000`, and rake is `1000` basis points (10%).
- At most two games may be `ACTIVE` or `SETTLING`; a table has at most 12 players; one user may hold only one active player lock.
- A completed settlement is immutable. There is no reopen, edit, delete, or recalculation path.
- Rake settings and per-user rake flags are live until final submission; a settings version change invalidates an open preview.
- Ordinary users may select only games they played, but single-game details and aggregates show every player in those selected games.
- Local integration uses `tianyi.wiki:8306`; production uses `192.168.10.248:3306`; secrets are environment-only.
- Capacity target is 50 accounts and no more than 30 concurrent online users.
- Public traffic must enter through Synology HTTPS/WSS reverse proxy; never publish the application, avatar, or MySQL ports directly.
- All user-visible screens are mobile-first for 360–430 px and use the approved midnight-blue/gold theme and round-table game layout.
- Every task uses test-first development, runs focused tests before broad tests, and ends in a reviewable commit.

---

## Target File Structure

```text
.
├── apps/
│   ├── api/
│   │   ├── prisma/
│   │   │   ├── migrations/
│   │   │   └── schema.prisma
│   │   ├── src/
│   │   │   ├── app.module.ts
│   │   │   ├── main.ts
│   │   │   ├── generated/prisma/
│   │   │   ├── common/{auth,money,errors}/
│   │   │   ├── prisma/
│   │   │   ├── health/
│   │   │   ├── auth/
│   │   │   ├── users/
│   │   │   ├── settings/
│   │   │   ├── audit/
│   │   │   ├── games/
│   │   │   ├── buyins/
│   │   │   ├── realtime/
│   │   │   ├── settlements/
│   │   │   ├── history/
│   │   │   └── uploads/
│   │   └── test/
│   └── web/
│       ├── public/{avatars,icons}/
│       ├── src/
│       │   ├── app/
│       │   ├── api/
│       │   ├── auth/
│       │   ├── components/
│       │   ├── features/{home,games,buyins,settlements,history,users,settings,profile}/
│       │   └── styles/
│       └── vite.config.ts
├── packages/
│   ├── contracts/src/
│   └── settlement/src/
├── tests/e2e/
├── scripts/{database,backup}/
├── Dockerfile
├── docker-compose.yml
├── docker-compose.test.yml
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

The API modules own business behavior. `packages/contracts` owns transport schemas only. `packages/settlement` is a framework-free deterministic calculation library. React feature folders own route-level UI and local presentation components.

---

### Task 1: Workspace Bootstrap and Running Vertical Slice

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/vitest.e2e.config.ts`
- Create: `apps/api/vitest.integration.config.ts`
- Create: `apps/api/test/setup.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/test/health.e2e-spec.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/test/setup.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/App.test.tsx`

**Interfaces:**
- Produces: `GET /api/health/live -> { status: "ok" }`.
- Produces: a React root that renders `德州计分` and can be built to `apps/web/dist`.
- Produces: root scripts `dev`, `build`, `test`, `lint`, and `typecheck` used by all following tasks.

- [ ] **Step 1: Create workspace manifests and install the exact dependency families**

```json
{
  "name": "poker-scorekeeper",
  "private": true,
  "packageManager": "pnpm@10.15.1",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "dev": "concurrently \"pnpm dev:api\" \"pnpm dev:web\"",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "dev:api": "pnpm --filter @poker/api dev",
    "dev:web": "pnpm --filter @poker/web dev"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^24.0.0",
    "concurrently": "^9.0.0",
    "eslint": "^9.0.0",
    "mariadb": "^3.4.0",
    "prettier": "^3.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

```yaml
packages:
  - apps/*
  - packages/*
```

```json
{
  "name": "@poker/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run --config vitest.config.ts",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/platform-socket.io": "^11.0.0",
    "@nestjs/throttler": "^6.0.0",
    "@nestjs/websockets": "^11.0.0",
    "@poker/contracts": "workspace:*",
    "@poker/settlement": "workspace:*",
    "@prisma/adapter-mariadb": "^7.0.0",
    "@prisma/client": "^7.0.0",
    "argon2": "^0.44.0",
    "helmet": "^8.0.0",
    "mariadb": "^3.4.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0",
    "sharp": "^0.34.0",
    "socket.io": "^4.8.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/supertest": "^6.0.0",
    "prisma": "^7.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

```json
{
  "name": "@poker/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@poker/contracts": "workspace:*",
    "@tanstack/react-query": "^5.0.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^7.0.0",
    "socket.io-client": "^4.8.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.0.0",
    "typescript": "^5.4.0",
    "vite": "^7.0.0",
    "vite-plugin-pwa": "^1.0.0",
    "vitest": "^3.0.0"
  }
}
```

Run:

```powershell
corepack enable
pnpm install
```

Expected: a new `pnpm-lock.yaml` and no dependency resolution errors on Node 24.

- [ ] **Step 2: Write failing API and web smoke tests**

```ts
// apps/api/test/health.e2e-spec.ts
it('GET /api/health/live returns ok', async () => {
  await request(app.getHttpServer())
    .get('/api/health/live')
    .expect(200)
    .expect({ status: 'ok' });
});
```

```tsx
// apps/web/src/app/App.test.tsx
it('renders the product name', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: '德州计分' })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

```powershell
pnpm --filter @poker/api test -- health.e2e-spec.ts
pnpm --filter @poker/web test -- App.test.tsx
```

Expected: FAIL because `AppModule`, `HealthController`, and `App` do not exist yet.

- [ ] **Step 4: Add the minimal NestJS and React implementations**

```ts
// apps/api/src/health/health.controller.ts
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

```tsx
// apps/web/src/app/App.tsx
export function App() {
  return <h1>德州计分</h1>;
}
```

`main.ts` must set the global prefix to `api`, listen on `0.0.0.0:${PORT || 3000}`, and enable graceful shutdown. Task 4 registers the shared Zod validation pipe that rejects unknown JSON fields.

- [ ] **Step 5: Run tests, type checking, and builds**

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Expected: all commands exit 0 and create `apps/api/dist` and `apps/web/dist`.

- [ ] **Step 6: Commit the vertical slice**

```powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.js .editorconfig .gitignore .env.example apps
git commit -m "chore: bootstrap scorekeeper workspace"
```

---

### Task 2: Shared Money Contracts and Pure Settlement Engine

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/money.ts`
- Test: `packages/contracts/src/money.test.ts`
- Create: `packages/contracts/src/settlement.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/settlement/package.json`
- Create: `packages/settlement/src/types.ts`
- Create: `packages/settlement/src/allocate-expense.ts`
- Create: `packages/settlement/src/calculate-settlement.ts`
- Create: `packages/settlement/src/index.ts`
- Test: `packages/settlement/src/allocate-expense.test.ts`
- Test: `packages/settlement/src/calculate-settlement.test.ts`

**Interfaces:**
- Produces: `MoneyJson` as a base-10 integer string.
- Produces: `parseMoney(value: MoneyJson): bigint` and `formatMoney(value: bigint): MoneyJson`.
- Produces: `allocateExpense(total, payerIds, players): Map<string, bigint>`.
- Produces: `calculateRake(afterFeeProfit, config): bigint`.
- Produces: `calculateSettlement(input: SettlementInput): SettlementOutput`.
- Consumed by: settlement API, history mapping, and React amount formatting.

- [ ] **Step 1: Write contract schemas and failing allocation tests**

```ts
export const moneyJsonSchema = z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/);
export type MoneyJson = z.infer<typeof moneyJsonSchema>;

export function parseMoney(value: MoneyJson): bigint {
  return BigInt(value);
}

export function formatMoney(value: bigint): MoneyJson {
  return value.toString() as MoneyJson;
}

export interface SettlementPlayerInput {
  playerId: string;
  seatNo: number;
  buyIn: bigint;
  cashOut: bigint;
  rakeEnabled: boolean;
}

export interface SettlementInput {
  players: SettlementPlayerInput[];
  gameRakeEnabled: boolean;
  rakeThreshold: bigint;
  rakeBps: number;
  roomFee: bigint;
  roomPayerIds: string[];
  otherFee: bigint;
  otherPayerIds: string[];
}

export interface SettlementPlayerResult extends SettlementPlayerInput {
  rawProfit: bigint;
  roomFeeShare: bigint;
  otherFeeShare: bigint;
  afterFeeProfit: bigint;
  rakeEligible: boolean;
  rakeAmount: bigint;
  finalAmount: bigint;
}

export interface SettlementOutput {
  results: SettlementPlayerResult[];
  buyInTotal: bigint;
  cashOutTotal: bigint;
  rawProfitTotal: bigint;
  roomFeeTotal: bigint;
  otherFeeTotal: bigint;
  rakeTotal: bigint;
  finalTotal: bigint;
}

export interface ProfitOrder {
  playerId: string;
  seatNo: number;
  rawProfit: bigint;
}

export interface RakeConfig {
  gameEnabled: boolean;
  userEnabled: boolean;
  threshold: bigint;
  bps: number;
}

export class SettlementError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
```

```ts
it('splits 380 yuan among three players by profit then seat', () => {
  const result = allocateExpense(380n, ['a', 'b', 'c'], [
    { playerId: 'a', seatNo: 2, rawProfit: 900n },
    { playerId: 'b', seatNo: 1, rawProfit: 900n },
    { playerId: 'c', seatNo: 3, rawProfit: -1800n },
  ]);
  expect(result).toEqual(new Map([['b', 127n], ['a', 127n], ['c', 126n]]));
});

it('accepts an all-zero balanced table', () => {
  expect(calculateSettlement(zeroTableInput()).finalTotal).toBe(0n);
});

it('rejects unbalanced cash-outs', () => {
  expect(() => calculateSettlement(unbalancedInput())).toThrow('TABLE_NOT_BALANCED');
});
```

- [ ] **Step 2: Run the allocation test and verify it fails**

```powershell
pnpm --filter @poker/settlement test -- allocate-expense.test.ts
```

Expected: FAIL because `allocateExpense` is not exported.

- [ ] **Step 3: Implement exact integer allocation**

```ts
export function allocateExpense(
  total: bigint,
  payerIds: string[],
  players: ProfitOrder[],
): Map<string, bigint> {
  if (total < 0n) throw new SettlementError('FEE_NEGATIVE');
  if (total > 0n && payerIds.length === 0) throw new SettlementError('FEE_PAYERS_REQUIRED');
  if (total === 0n) return new Map(payerIds.map((id) => [id, 0n]));

  const selected = players
    .filter((player) => payerIds.includes(player.playerId))
    .sort((left, right) =>
      left.rawProfit === right.rawProfit
        ? left.seatNo - right.seatNo
        : left.rawProfit > right.rawProfit ? -1 : 1,
    );
  if (selected.length !== new Set(payerIds).size) throw new SettlementError('UNKNOWN_FEE_PAYER');

  const divisor = BigInt(selected.length);
  const quotient = total / divisor;
  const remainder = Number(total % divisor);
  return new Map(selected.map((player, index) => [
    player.playerId,
    quotient + (index < remainder ? 1n : 0n),
  ]));
}
```

- [ ] **Step 4: Write failing settlement formula tests**

```ts
it('calculates fees, threshold-equal rake, and final totals', () => {
  const result = calculateSettlement({
    gameRakeEnabled: true,
    rakeThreshold: 1000n,
    rakeBps: 1000,
    roomFee: 380n,
    roomPayerIds: ['a'],
    otherFee: 120n,
    otherPayerIds: ['a', 'b'],
    players: [
      { playerId: 'a', seatNo: 1, buyIn: 1500n, cashOut: 3000n, rakeEnabled: true },
      { playerId: 'b', seatNo: 2, buyIn: 900n, cashOut: 400n, rakeEnabled: true },
      { playerId: 'c', seatNo: 3, buyIn: 1200n, cashOut: 200n, rakeEnabled: true },
    ],
  });
  expect(result.results.find((row) => row.playerId === 'a')).toMatchObject({
    rawProfit: 1500n,
    roomFeeShare: 380n,
    otherFeeShare: 60n,
    afterFeeProfit: 1060n,
    rakeAmount: 106n,
    finalAmount: 954n,
  });
  expect(result.finalTotal).toBe(-606n);
});
```

Add the boundary matrix as executable cases:

```ts
it.each([
  ['threshold equal', 1000n, true, true, 1000, 100n],
  ['game rake disabled', 1200n, false, true, 1000, 0n],
  ['user rake disabled', 1200n, true, false, 1000, 0n],
  ['negative profit', -1200n, true, true, 1000, 0n],
  ['zero percent', 1200n, true, true, 0, 0n],
  ['one hundred percent', 1200n, true, true, 10000, 1200n],
])('%s', (_name, afterFee, gameEnabled, userEnabled, bps, expectedRake) => {
  expect(calculateRake(afterFee, { gameEnabled, userEnabled, threshold: 1000n, bps }))
    .toBe(expectedRake);
});
```

- [ ] **Step 5: Implement `calculateSettlement` and its invariants**

```ts
export function calculateRake(afterFeeProfit: bigint, config: RakeConfig): bigint {
  const eligible = config.gameEnabled
    && config.userEnabled
    && afterFeeProfit >= config.threshold
    && afterFeeProfit > 0n;
  return eligible ? (afterFeeProfit * BigInt(config.bps) + 5000n) / 10000n : 0n;
}

const rakeAmount = calculateRake(afterFeeProfit, {
  gameEnabled: input.gameRakeEnabled,
  userEnabled: player.rakeEnabled,
  threshold: input.rakeThreshold,
  bps: input.rakeBps,
});
const finalAmount = afterFeeProfit - rakeAmount;

if (cashOutTotal !== buyInTotal) throw new SettlementError('TABLE_NOT_BALANCED');
if (rawProfitTotal !== 0n) throw new SettlementError('RAW_PROFIT_NOT_ZERO');
if (finalTotal !== -(input.roomFee + input.otherFee + rakeTotal)) {
  throw new SettlementError('FINAL_TOTAL_INVALID');
}
```

- [ ] **Step 6: Run package tests and mutation-prone boundary cases**

```powershell
pnpm --filter @poker/contracts test
pnpm --filter @poker/settlement test
pnpm --filter @poker/settlement typecheck
```

Expected: PASS with no number-based money arithmetic in `packages/settlement`.

- [ ] **Step 7: Commit the domain engine**

```powershell
git add packages
git commit -m "feat: add deterministic settlement engine"
```

---

### Task 3: Prisma Schema, Migrations, and Database Safety Guard

**Files:**
- Create: `apps/api/prisma.config.ts`
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260817000100_initial/migration.sql`
- Create: `apps/api/src/prisma/prisma.module.ts`
- Create: `apps/api/src/prisma/prisma.service.ts`
- Create: `apps/api/src/prisma/prisma-money.ts`
- Create: `scripts/database/create-database.mjs`
- Create: `scripts/database/assert-test-database.mjs`
- Test: `apps/api/test/prisma-schema.integration-spec.ts`
- Modify: `.env.example`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `PrismaService` for all API repositories.
- Produces: `toDbMoney(bigint): bigint` and `fromDbMoney(bigint): bigint` boundary helpers.
- Produces database models: `User`, `AuthSession`, `SystemSetting`, `Game`, `GamePlayer`, `ActivePlayerLock`, `BuyinEvent`, `SettlementDraft`, `Settlement`, `SettlementResult`, `SettlementFeeAllocation`, and `AuditLog`.
- Produces enums: `Role`, `AvatarKind`, `GameStatus`, `BuyinEventType`, and `FeeType`.

- [ ] **Step 1: Add Prisma 7 configuration and guarded database scripts**

```ts
// apps/api/prisma.config.ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

```js
// scripts/database/assert-test-database.mjs
const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.slice(1);
if (!database.endsWith('_test')) {
  throw new Error(`Refusing destructive test operation on database: ${database}`);
}
```

```js
// scripts/database/create-database.mjs
import mariadb from 'mariadb';

const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.slice(1);
if (!/^[a-z][a-z0-9_]{2,63}$/.test(database)) throw new Error('Invalid database name');
const connection = await mariadb.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
});
try {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
} finally {
  await connection.end();
}
```

`.env.example` must contain separate placeholder URLs for `poker_scorekeeper_test` and `poker_scorekeeper`, never a real password.

- [ ] **Step 2: Write a failing schema integration test**

```ts
it('creates all financial tables and one settings row', async () => {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `;
  expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
    'users', 'games', 'buyin_events', 'settlements', 'settlement_results', 'audit_logs',
  ]));
  expect(await prisma.systemSetting.count()).toBe(1);
});
```

- [ ] **Step 3: Run it against an isolated `_test` schema and verify failure**

```powershell
node scripts/database/create-database.mjs
node scripts/database/assert-test-database.mjs
pnpm --filter @poker/api prisma migrate reset --force
pnpm --filter @poker/api test:integration -- prisma-schema.integration-spec.ts
```

Expected: FAIL because the schema has not defined the models.

- [ ] **Step 4: Define the exact enums, models, and constraints from the complete inventory below**

The schema must use this money and identity pattern consistently:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "mysql"
}

enum Role { SUPER_ADMIN ADMIN USER }
enum AvatarKind { PRESET UPLOAD }
enum GameStatus { DRAFT ACTIVE SETTLING COMPLETED VOIDED }
enum BuyinEventType { BUY ADJUST }
enum FeeType { ROOM OTHER }

model SettlementResult {
  id                  String   @id @default(cuid()) @db.VarChar(30)
  settlementId        String   @map("settlement_id") @db.VarChar(30)
  gamePlayerId        String   @map("game_player_id") @db.VarChar(30)
  buyIn               BigInt   @map("buy_in")
  cashOut             BigInt   @map("cash_out")
  rawProfit           BigInt   @map("raw_profit")
  roomFeeShare        BigInt   @map("room_fee_share")
  otherFeeShare       BigInt   @map("other_fee_share")
  afterFeeProfit      BigInt   @map("after_fee_profit")
  rakeEligible        Boolean  @map("rake_eligible")
  rakeAmount          BigInt   @map("rake_amount")
  finalAmount         BigInt   @map("final_amount")
  createdAt           DateTime @default(now()) @map("created_at")
  settlement          Settlement @relation(fields: [settlementId], references: [id])
  gamePlayer          GamePlayer @relation(fields: [gamePlayerId], references: [id])

  @@unique([settlementId, gamePlayerId])
  @@map("settlement_results")
}
```

Use this complete model inventory; no financial column may be omitted or collapsed into JSON:

| Model | Required typed fields beyond `id` |
|---|---|
| `User` | `username`, `normalizedUsername`, `nickname`, `activeNormalizedNickname?`, `passwordHash`, `role`, `rakeEnabled`, `avatarKind`, `avatarValue`, `isActive`, `mustChangePassword`, `createdById?`, `deletedAt?`, timestamps |
| `AuthSession` | `userId`, unique `tokenHash`, `expiresAt`, `absoluteExpiresAt`, `lastSeenAt`, `ipAddress`, `userAgent`, `revokedAt?`, timestamps |
| `SystemSetting` | singleton `id`, `rakeThreshold BigInt`, `rakeBps Int`, `version Int`, `updatedById?`, timestamps |
| `Game` | `name`, `handPrice BigInt`, `rakeEnabled`, `status`, `version`, `createdById`, `startedAt?`, `stoppedAt?`, `completedAt?`, `settledById?`, timestamps |
| `GamePlayer` | `gameId`, `userId`, `nicknameSnapshot`, avatar kind/value snapshots, `seatNo`, `firstBuyinAt`, timestamp |
| `ActivePlayerLock` | primary-key `userId`, `gameId`, timestamp |
| `BuyinEvent` | `gameId`, `gamePlayerId`, `actorUserId`, `type`, `logicalBuyId`, `previousHands?`, `newHands`, `handsDelta`, unique `idempotencyKey`, timestamp |
| `SettlementDraft` | unique `gameId`, validated `payload Json`, `version`, `editorUserId`, `leaseExpiresAt`, `updatedById`, timestamps |
| `Settlement` | unique `gameId`, `buyInTotal`, `cashOutTotal`, `roomFee`, `otherFee`, `otherFeeNote`, `rakeThresholdUsed`, `rakeBpsUsed`, `settingsVersionUsed`, `rakeTotal`, `finalTotal`, `settledById`, `lockedAt`, timestamp |
| `SettlementResult` | exact typed fields shown in the Prisma block above |
| `SettlementFeeAllocation` | `settlementId`, `feeType`, `gamePlayerId`, `allocationOrder`, `amount BigInt`, `receivedRemainder`, timestamp |
| `AuditLog` | `actorUserId?`, `action`, `entityType`, `entityId`, `requestId`, `beforeJson?`, `afterJson?`, `sourceIp`, `userAgent`, timestamp |

Map tables and columns to snake_case. Add the exact unique and lookup indexes from approved design section 11.13, including active nickname, game/user, game/seat, idempotency, one settlement per game, one result per settlement/player, and audit entity/time indexes.

The initial migration must seed the singleton row explicitly:

```sql
INSERT INTO system_settings
  (id, rake_threshold, rake_bps, version, created_at, updated_at)
VALUES
  ('singleton', 1000, 1000, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
```

Implement every field, relation, index, and unique constraint in the inventory and index list immediately above. Store the settlement draft payload as validated JSON plus `version`, `editorUserId`, and `leaseExpiresAt`; permanent financial values remain typed `BigInt` columns.

- [ ] **Step 5: Generate and inspect the initial migration**

```powershell
pnpm --filter @poker/api prisma format
pnpm --filter @poker/api prisma validate
pnpm --filter @poker/api prisma migrate dev --name initial
```

Expected: SQL uses `utf8mb4`, includes all foreign keys and unique indexes, and creates no floating-point financial column.

- [ ] **Step 6: Implement `PrismaService` with the MySQL adapter**

```ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const url = new URL(config.getOrThrow<string>('DATABASE_URL'));
    const adapter = new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      connectionLimit: 10,
    });
    super({ adapter });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **Step 7: Re-run reset, integration test, generate, and typecheck**

```powershell
node scripts/database/assert-test-database.mjs
pnpm --filter @poker/api prisma migrate reset --force
pnpm --filter @poker/api test:integration -- prisma-schema.integration-spec.ts
pnpm --filter @poker/api typecheck
```

Expected: PASS and a singleton settings row with threshold `1000`, rake BPS `1000`, and version `1`.

- [ ] **Step 8: Commit schema and migration**

```powershell
git add apps/api/prisma.config.ts apps/api/prisma apps/api/src/prisma apps/api/src/app.module.ts scripts/database .env.example
git commit -m "feat: add immutable financial schema"
```

---

### Task 4: Session Authentication, Bootstrap Super Admin, and CSRF

**Files:**
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/auth/session.service.ts`
- Create: `apps/api/src/auth/bootstrap-admin.service.ts`
- Create: `apps/api/src/auth/password.service.ts`
- Create: `apps/api/src/auth/csrf.service.ts`
- Create: `apps/api/src/common/auth/auth-user.ts`
- Create: `apps/api/src/common/auth/current-user.decorator.ts`
- Create: `apps/api/src/common/auth/session.guard.ts`
- Create: `apps/api/src/common/auth/csrf.guard.ts`
- Create: `apps/api/src/common/auth/roles.decorator.ts`
- Create: `apps/api/src/common/auth/roles.guard.ts`
- Create: `apps/api/src/common/errors/app-error.ts`
- Create: `apps/api/src/common/errors/error-codes.ts`
- Create: `apps/api/src/common/errors/api-exception.filter.ts`
- Create: `apps/api/src/common/validation/zod-validation.pipe.ts`
- Create: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/change-password`.
- Produces: `AuthUser { id, username, nickname, role, mustChangePassword }`.
- Produces: `@CurrentUser()` and `SessionGuard` for all protected modules.
- Produces: `@Roles('SUPER_ADMIN', 'ADMIN')` and `RolesGuard`.
- Produces stable error bodies with at least `{ code, message }`; Task 17 adds production request IDs and log correlation.
- Produces: `X-CSRF-Token` requirement for every unsafe authenticated request.

- [ ] **Step 1: Write failing authentication e2e tests**

```ts
it('logs in, sets a secure session cookie, and returns a csrf token', async () => {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ username: 'rootadmin', password: 'CorrectHorse123!' })
    .expect(201);
  expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
  expect(response.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.user.mustChangePassword).toBe(true);
});

it('rejects an unsafe request without csrf', async () => {
  await request(app.getHttpServer())
    .post('/api/auth/logout')
    .set('Cookie', sessionCookie)
    .expect(403)
    .expect(({ body }) => expect(body.code).toBe('CSRF_INVALID'));
});
```

Use a table for all rejected session states:

```ts
it.each([
  ['wrong password', seedActiveUser, 'wrong-password', 401, 'INVALID_CREDENTIALS'],
  ['disabled user', seedDisabledUser, 'CorrectHorse123!', 401, 'INVALID_CREDENTIALS'],
  ['deleted user', seedDeletedUser, 'CorrectHorse123!', 401, 'INVALID_CREDENTIALS'],
])('%s', async (_name, seed, password, status, code) => {
  const user = await seed();
  await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ username: user.username, password })
    .expect(status)
    .expect(({ body }) => expect(body.code).toBe(code));
});
```

Add these concrete state tests:

```ts
it('rejects an expired session', async () => {
  const cookie = await seedSession({ expiresAt: new Date(Date.now() - 1000) });
  await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
});

it('blocks non-auth routes until the forced password change completes', async () => {
  const context = mockHttpContext({ path: '/api/games/current', cookie: forcedChangeCookie });
  await expect(sessionGuard.canActivate(context)).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
});

it('revokes every other session after password change', async () => {
  await changePassword(primaryCookie, csrfToken).expect(200);
  await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', secondaryCookie).expect(401);
});

it('throttles the eleventh failed login', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) await failedLogin().expect(401);
  await failedLogin().expect(429);
});
```

- [ ] **Step 2: Run the focused suite and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- auth.e2e-spec.ts
```

Expected: FAIL with missing auth routes.

- [ ] **Step 3: Implement Argon2id passwords and hashed random sessions**

```ts
const rawToken = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(rawToken).digest('hex');
const csrfToken = createHmac('sha256', csrfSecret)
  .update(`${session.id}:${user.id}`)
  .digest('hex');

const idleExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const absoluteExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
```

Cookie options must be `httpOnly: true`, `secure: production`, `sameSite: 'lax'`, `path: '/'`, with a seven-day idle expiry. Store only the session token hash. Compare CSRF tokens with `timingSafeEqual`.

- [ ] **Step 4: Implement bootstrap admin with an idempotent transaction**

```ts
if (await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } }) === 0) {
  await prisma.user.create({
    data: {
      username: bootstrapUsername,
      normalizedUsername: bootstrapUsername.toLowerCase(),
      nickname: bootstrapNickname,
      activeNormalizedNickname: normalizeNickname(bootstrapNickname),
      passwordHash: await passwordService.hash(bootstrapPassword),
      role: 'SUPER_ADMIN',
      mustChangePassword: true,
    },
  });
}
```

Production startup must fail if no super admin exists and any bootstrap variable is missing.

- [ ] **Step 5: Implement guards and route behavior**

`SessionGuard` must load the current user on every request so role, active state, and forced-password state take effect immediately. `CsrfGuard` must exempt safe methods and `/api/auth/login`, but protect every other `POST`, `PATCH`, `PUT`, and `DELETE`.

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const request = context.switchToHttp().getRequest<RequestWithAuth>();
  const user = await this.sessions.authenticateCookie(request.headers.cookie);
  if (!user) throw unauthorized('UNAUTHENTICATED');
  if (user.mustChangePassword && !request.path.startsWith('/api/auth/')) {
    throw forbidden('PASSWORD_CHANGE_REQUIRED');
  }
  request.user = user;
  return true;
}

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const actor = context.switchToHttp().getRequest<RequestWithAuth>().user;
    if (allowed.length > 0 && !allowed.includes(actor.role)) throw forbidden('FORBIDDEN');
    return true;
  }
}
```

- [ ] **Step 6: Run auth tests and the broad API suite**

```powershell
pnpm --filter @poker/api test:e2e -- auth.e2e-spec.ts
pnpm --filter @poker/api test
pnpm --filter @poker/api typecheck
```

Expected: PASS; no raw password or session token appears in captured logs.

- [ ] **Step 7: Commit authentication**

```powershell
git add apps/api/src/auth apps/api/src/common/auth apps/api/src/app.module.ts apps/api/test/auth.e2e-spec.ts .env.example
git commit -m "feat: add secure session authentication"
```

---

### Task 5: User Administration and Avatar Pipeline

**Files:**
- Create: `apps/api/src/users/users.module.ts`
- Create: `apps/api/src/users/users.controller.ts`
- Create: `apps/api/src/users/users.service.ts`
- Create: `apps/api/src/users/user-policy.ts`
- Create: `apps/api/src/users/user-normalization.ts`
- Create: `packages/contracts/src/users.ts`
- Create: `packages/contracts/src/avatars.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/uploads/avatar.service.ts`
- Create: `apps/api/src/uploads/avatar.controller.ts`
- Create: `apps/api/src/uploads/preset-avatars.ts`
- Create: `apps/api/test/users.e2e-spec.ts`
- Create: `apps/api/test/avatars.e2e-spec.ts`
- Create: `apps/web/public/avatars/preset-01.webp`
- Create: `apps/web/public/avatars/preset-02.webp`
- Create: `apps/web/public/avatars/preset-03.webp`
- Create: `apps/web/public/avatars/preset-04.webp`
- Create: `apps/web/public/avatars/preset-05.webp`
- Create: `apps/web/public/avatars/preset-06.webp`
- Create: `apps/web/public/avatars/preset-07.webp`
- Create: `apps/web/public/avatars/preset-08.webp`
- Create: `apps/web/public/avatars/preset-09.webp`
- Create: `apps/web/public/avatars/preset-10.webp`
- Create: `apps/web/public/avatars/preset-11.webp`
- Create: `apps/web/public/avatars/preset-12.webp`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`, `POST /api/users/:id/restore`, `POST /api/users/:id/reset-password`, and `POST /api/users/:id/avatar/reset`.
- Produces: `GET /api/avatars/presets`, `PUT /api/me/avatar/preset`, `POST /api/me/avatar/upload`, and admin avatar reset.
- Produces: `normalizeUsername`, `normalizeNickname`, and `assertCanManageUser(actor, target, change)`.

- [ ] **Step 1: Write failing role and lifecycle tests**

```ts
it.each([
  ['ADMIN', 'ADMIN', 403],
  ['ADMIN', 'USER', 201],
  ['SUPER_ADMIN', 'ADMIN', 201],
])('%s creating %s returns %s', async (actorRole, targetRole, status) => {
  await createUserAs(actorRole, { username: `user-${targetRole}`, nickname: `昵称-${targetRole}`, role: targetRole })
    .expect(status);
});

it('prevents deleting the last active super admin', async () => {
  await deleteUserAs('SUPER_ADMIN', lastSuperAdmin.id)
    .expect(409)
    .expect(({ body }) => expect(body.code).toBe('LAST_SUPER_ADMIN'));
});
```

Add this lifecycle table to the same suite:

```ts
it.each([
  ['duplicate username', () => createDuplicateUsername(), 409, 'USERNAME_TAKEN'],
  ['restore nickname collision', () => restoreWithTakenNickname(), 409, 'NICKNAME_TAKEN'],
  ['delete active player', () => deleteActivePlayer(), 409, 'USER_IN_ACTIVE_GAME'],
])('%s', async (_name, action, status, code) => {
  await action().then((response) => {
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });
});
```

Add exact success-path assertions:

```ts
it('allows a deleted nickname to be reused', async () => {
  await softDeleteUser(original.id);
  await createUserAs('ADMIN', { username: 'new-user', nickname: original.nickname, role: 'USER' }).expect(201);
});

it('forces password change after admin reset', async () => {
  await resetPasswordAs('ADMIN', user.id).expect(200);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(true);
});

it.each(['role', 'isActive'])('revokes sessions after %s changes', async (field) => {
  await updateUserAs('SUPER_ADMIN', user.id, field === 'role' ? { role: 'ADMIN' } : { isActive: false });
  expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
});
```

- [ ] **Step 2: Run user tests and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- users.e2e-spec.ts
```

Expected: FAIL because user administration routes do not exist.

- [ ] **Step 3: Implement normalization and transaction-level policy checks**

```ts
export function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

export function normalizeNickname(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/),
  nickname: z.string().trim().min(1).max(20),
  initialPassword: z.string().min(8).max(128),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'USER']),
  rakeEnabled: z.boolean().default(true),
});
```

Deletion, disabling, and demotion must query `activePlayerLock` and lock/count active super admins in the same transaction before mutating the user.

```ts
await prisma.$transaction(async (tx) => {
  const activeLock = await tx.activePlayerLock.findUnique({ where: { userId: target.id } });
  if (activeLock) throw conflict('USER_IN_ACTIVE_GAME');
  if (target.role === 'SUPER_ADMIN') {
    const activeSupers = await tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null } });
    if (activeSupers <= 1) throw conflict('LAST_SUPER_ADMIN');
  }
  await tx.user.update({ where: { id: target.id }, data: requestedChange });
  await tx.authSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
});
```

- [ ] **Step 4: Write failing avatar validation tests**

```ts
it('re-encodes an uploaded image to a 256px webp', async () => {
  const response = await uploadAvatar(validPng).expect(201);
  const metadata = await sharp(join(avatarRoot, response.body.path)).metadata();
  expect(metadata).toMatchObject({ format: 'webp', width: 256, height: 256 });
});

it('rejects a script renamed to png', async () => {
  await uploadAvatar(Buffer.from('<script>alert(1)</script>'), 'face.png')
    .expect(415);
});
```

- [ ] **Step 5: Implement the avatar pipeline**

```ts
const filename = `${userId}-${randomUUID()}.webp`;
await sharp(input)
  .rotate()
  .resize(256, 256, { fit: 'cover', position: 'centre' })
  .webp({ quality: 86 })
  .toFile(join(avatarRoot, filename));
```

Accept at most 5 MiB, inspect decodable image content rather than extension, write through a temporary file, update the user only after conversion succeeds, and delete the previous uploaded file only after commit.

- [ ] **Step 6: Run user/avatar tests and inspect filesystem cleanup**

```powershell
pnpm --filter @poker/api test:e2e -- users.e2e-spec.ts avatars.e2e-spec.ts
pnpm --filter @poker/api typecheck
```

Expected: PASS; failed uploads and replaced avatars leave no orphan temporary file.

- [ ] **Step 7: Commit user management and avatar presets**

```powershell
git add apps/api/src/users apps/api/src/uploads apps/api/test/users.e2e-spec.ts apps/api/test/avatars.e2e-spec.ts apps/web/public/avatars
git commit -m "feat: add user and avatar management"
```

---

### Task 6: Audit Trail and Live Rake Settings

**Files:**
- Create: `apps/api/src/audit/audit.module.ts`
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/audit-redaction.ts`
- Create: `apps/api/src/settings/settings.module.ts`
- Create: `apps/api/src/settings/settings.controller.ts`
- Create: `apps/api/src/settings/settings.service.ts`
- Create: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/settings.e2e-spec.ts`
- Test: `apps/api/src/audit/audit-redaction.test.ts`
- Modify: `apps/api/src/users/users.service.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `AuditService.record(tx, entry)` used inside user, setting, game, buy-in, and settlement transactions.
- Produces: `GET /api/settings/rake` and super-admin-only `PATCH /api/settings/rake`.
- Produces: `RakeSettingsDto { threshold: MoneyJson; bps: number; version: number }`.

- [ ] **Step 1: Write failing setting permission/version tests**

```ts
it('increments the settings version and records the actor', async () => {
  const response = await patchRakeAs('SUPER_ADMIN', { threshold: '1500', bps: 1250, version: 1 })
    .expect(200);
  expect(response.body).toMatchObject({ threshold: '1500', bps: 1250, version: 2 });
  expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(1);
});

it('rejects stale settings versions', async () => {
  await patchRakeAs('SUPER_ADMIN', { threshold: '1000', bps: 1000, version: 1 })
    .expect(409)
    .expect(({ body }) => expect(body.code).toBe('SETTINGS_VERSION_CONFLICT'));
});
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- settings.e2e-spec.ts
```

Expected: FAIL because the settings module does not exist.

- [ ] **Step 3: Implement optimistic versioning and validation**

```ts
const updated = await tx.systemSetting.updateMany({
  where: { id: SETTINGS_ID, version: dto.version },
  data: {
    rakeThreshold: BigInt(dto.threshold),
    rakeBps: dto.bps,
    version: { increment: 1 },
    updatedById: actor.id,
  },
});
if (updated.count !== 1) throw conflict('SETTINGS_VERSION_CONFLICT');
```

Validate threshold as a non-negative integer string and BPS as an integer from 0 through 10000.

- [ ] **Step 4: Implement audit redaction and transaction participation**

```ts
const forbiddenKeys = new Set(['password', 'passwordHash', 'cookie', 'token', 'databaseUrl']);
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      forbiddenKeys.has(key) ? '[REDACTED]' : redact(child),
    ]));
  }
  return value;
}
```

Update user-management transactions in the same task so create, role change, rake flag change, reset, delete, restore, and avatar reset call `AuditService.record` before commit.

```ts
await audit.record(tx, {
  actorUserId: actor.id,
  action: 'USER_UPDATED',
  entityType: 'USER',
  entityId: target.id,
  before: redact(before),
  after: redact(after),
});
```

- [ ] **Step 5: Run settings, redaction, and permission tests**

```powershell
pnpm --filter @poker/api test -- audit-redaction.test.ts
pnpm --filter @poker/api test:e2e -- settings.e2e-spec.ts
```

Expected: PASS and no sensitive value in serialized audit payloads.

- [ ] **Step 6: Commit settings and audit infrastructure**

```powershell
git add apps/api/src/audit apps/api/src/settings apps/api/test/settings.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat: add audited live rake settings"
```

---

### Task 7: Game Lifecycle, Two-Table Limit, and Current Game Queries

**Files:**
- Create: `apps/api/src/games/games.module.ts`
- Create: `apps/api/src/games/games.controller.ts`
- Create: `apps/api/src/games/games.service.ts`
- Create: `apps/api/src/games/game-policy.ts`
- Create: `apps/api/src/games/game-snapshot.mapper.ts`
- Create: `packages/contracts/src/games.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/games.e2e-spec.ts`
- Test: `apps/api/test/games-concurrency.integration-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `POST /api/games`, `POST /api/games/:id/start`, `POST /api/games/:id/begin-settlement`, `DELETE /api/games/:id/draft`, `POST /api/games/:id/void`, `GET /api/games/current`, and `GET /api/games/:id/snapshot`.
- Produces: `GameSnapshotDto` with version, timer timestamps, players, purchases, and online spectators.
- Consumes: `SessionGuard`, `AuditService`, and `PrismaService`.

```ts
export interface GameSnapshotDto {
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'SETTLING' | 'COMPLETED' | 'VOIDED';
  version: number;
  handPrice: MoneyJson;
  rakeEnabled: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  serverNow: string;
  players: Array<{
    id: string; userId: string; nickname: string; avatarUrl: string;
    seatNo: number; effectiveHands: number; buyInAmount: MoneyJson;
  }>;
  purchases: Array<{
    id: string; playerId: string; actorNickname: string; type: 'BUY' | 'ADJUST';
    previousHands: number | null; newHands: number; handsDelta: number; createdAt: string;
  }>;
  spectators: Array<{ userId: string; nickname: string; avatarUrl: string }>;
}
```

- [ ] **Step 1: Write failing lifecycle and permission tests**

```ts
it('uses defaults and generates an editable evening name', async () => {
  const response = await createGameAs('ADMIN', {}).expect(201);
  expect(response.body.handPrice).toBe('300');
  expect(response.body.rakeEnabled).toBe(true);
  expect(response.body.name).toMatch(/月.*(早场|午场|晚场)/);
});

it('allows only two ACTIVE or SETTLING games', async () => {
  await startTwoGames();
  await startGameAs('ADMIN', thirdDraft.id)
    .expect(409)
    .expect(({ body }) => expect(body.code).toBe('ACTIVE_GAME_LIMIT'));
});
```

Add concrete state-policy cases:

```ts
it.each([
  ['duplicate active name', () => startDuplicateName(), 409, 'ACTIVE_GAME_NAME_TAKEN'],
  ['normal user creates game', () => createGameAs('USER', {}), 403, 'FORBIDDEN'],
  ['delete draft', () => deleteDraft(), 204, null],
  ['void zero-buy active game', () => voidZeroBuyGame(), 200, null],
  ['void purchased game', () => voidPurchasedGame(), 409, 'GAME_HAS_BUYINS'],
])('%s', async (_name, action, status, code) => {
  const response = await action();
  expect(response.status).toBe(status);
  if (code) expect(response.body.code).toBe(code);
});
```

- [ ] **Step 2: Run lifecycle tests and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- games.e2e-spec.ts
```

Expected: FAIL because game routes do not exist.

- [ ] **Step 3: Implement game state transitions**

```ts
const allowedTransitions: Record<GameStatus, GameStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['SETTLING', 'VOIDED'],
  SETTLING: ['COMPLETED'],
  COMPLETED: [],
  VOIDED: [],
};
```

Use explicit service methods for each transition. Do not expose a generic status patch endpoint.

- [ ] **Step 4: Implement serialized start and end transactions**

Lock the singleton settings row with `SELECT ... FOR UPDATE`, count `ACTIVE` plus `SETTLING`, and update the draft only while its status/version matches. `begin-settlement` must lock the game row before changing status so no purchase can commit afterward.

```ts
await tx.$queryRaw`SELECT id FROM system_settings WHERE id = ${SETTINGS_ID} FOR UPDATE`;
const openCount = await tx.game.count({ where: { status: { in: ['ACTIVE', 'SETTLING'] } } });
if (openCount >= 2) throw conflict('ACTIVE_GAME_LIMIT');
```

- [ ] **Step 5: Run a real two-request concurrency test**

```ts
const results = await Promise.allSettled([
  service.start(firstDraft.id, admin),
  service.start(secondDraft.id, admin),
]);
expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
expect(await prisma.game.count({ where: { status: { in: ['ACTIVE', 'SETTLING'] } } })).toBe(2);
```

- [ ] **Step 6: Run focused and broad game tests**

```powershell
pnpm --filter @poker/api test:e2e -- games.e2e-spec.ts
pnpm --filter @poker/api test:integration -- games-concurrency.integration-spec.ts
pnpm --filter @poker/api typecheck
```

Expected: PASS with deterministic conflict codes.

- [ ] **Step 7: Commit game lifecycle**

```powershell
git add apps/api/src/games apps/api/test/games.e2e-spec.ts apps/api/test/games-concurrency.integration-spec.ts apps/api/src/app.module.ts
git commit -m "feat: add controlled game lifecycle"
```

---

### Task 8: Buy-In Ledger, Corrections, and Idempotency

**Files:**
- Create: `apps/api/src/buyins/buyins.module.ts`
- Create: `apps/api/src/buyins/buyins.controller.ts`
- Create: `apps/api/src/buyins/buyins.service.ts`
- Create: `apps/api/src/buyins/buyin-ledger.ts`
- Create: `packages/contracts/src/buyins.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/src/buyins/buyin-ledger.test.ts`
- Test: `apps/api/test/buyins.e2e-spec.ts`
- Test: `apps/api/test/buyins-concurrency.integration-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `POST /api/games/:gameId/buyins` with `{ hands, idempotencyKey }`.
- Produces: `POST /api/games/:gameId/players/:playerId/buyins/latest/adjust` with `{ newHands, idempotencyKey }`.
- Produces: `getEffectiveBuyins(gameId)` and `getPlayerBuyInTotal(gamePlayerId): bigint`.
- Produces immutable `BUY`/`ADJUST` chains consumed by snapshots and settlement drafts.

- [ ] **Step 1: Write failing ledger tests**

```ts
it('keeps the original buy and appends a -2 correction', () => {
  const ledger = foldBuyinEvents([
    { type: 'BUY', logicalBuyId: 'buy-1', handsDelta: 5 },
    { type: 'ADJUST', logicalBuyId: 'buy-1', handsDelta: -2 },
  ]);
  expect(ledger).toEqual([{ logicalBuyId: 'buy-1', effectiveHands: 3 }]);
});
```

Add the correction matrix:

```ts
it.each([
  ['repeat correction', [buy(5), adjust(-2), adjust(1)], 4],
  ['correct to zero', [buy(5), adjust(-5)], 0],
])('%s', (_name, events, expectedHands) => {
  expect(foldBuyinEvents(events)[0].effectiveHands).toBe(expectedHands);
});

it('rejects a negative effective total', () => {
  expect(() => foldBuyinEvents([buy(1), adjust(-2)])).toThrow('BUYIN_TOTAL_NEGATIVE');
});

it('refuses correction of an older logical buy', () => {
  expect(() => assertLatestLogicalBuy([buy(2, 'first'), buy(1, 'second')], 'first'))
    .toThrow('BUYIN_NOT_LATEST');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm --filter @poker/api test -- buyin-ledger.test.ts
```

Expected: FAIL because `foldBuyinEvents` is absent.

- [ ] **Step 3: Implement event folding and server-side validation**

```ts
export function foldBuyinEvents(events: LedgerEvent[]): EffectiveBuy[] {
  const buys = new Map<string, number>();
  for (const event of events) {
    const next = (buys.get(event.logicalBuyId) ?? 0) + event.handsDelta;
    if (next < 0) throw new BuyinError('BUYIN_TOTAL_NEGATIVE');
    buys.set(event.logicalBuyId, next);
  }
  return [...buys].map(([logicalBuyId, effectiveHands]) => ({ logicalBuyId, effectiveHands }));
}
```

- [ ] **Step 4: Write failing API and concurrency tests**

```ts
it('replays the original response for a duplicate idempotency key', async () => {
  const first = await buyHands(game.id, 5, 'request-123').expect(201);
  const second = await buyHands(game.id, 5, 'request-123').expect(200);
  expect(second.body.eventId).toBe(first.body.eventId);
  expect(await prisma.buyinEvent.count()).toBe(1);
});

it('allows only one of two simultaneous first buys in different games', async () => {
  const outcomes = await Promise.allSettled([
    buyinService.buy(gameA.id, user, 1, 'a'),
    buyinService.buy(gameB.id, user, 1, 'b'),
  ]);
  expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
});
```

- [ ] **Step 5: Implement transactional buy and adjust flows**

On first buy: lock the game, verify `ACTIVE`, count players below 12, insert the unique `active_player_lock`, snapshot nickname/avatar, allocate the smallest unused seat, append `BUY`, and audit. On adjust: lock the player and latest logical `BUY`, verify actor policy and status, compute delta, append `ADJUST`, and audit. Return an existing event for a repeated idempotency key.

```ts
return prisma.$transaction(async (tx) => {
  const replay = await tx.buyinEvent.findUnique({ where: { idempotencyKey } });
  if (replay) return mapBuyinEvent(replay, true);
  const game = await lockGame(tx, gameId);
  assertGameActive(game);
  const player = await findOrCreateLockedPlayer(tx, game, user);
  const event = await tx.buyinEvent.create({
    data: { gameId, gamePlayerId: player.id, actorUserId: actor.id, type: 'BUY', newHands: hands, handsDelta: hands, idempotencyKey },
  });
  await tx.game.update({ where: { id: gameId }, data: { version: { increment: 1 } } });
  await audit.record(tx, buyAudit(event));
  return mapBuyinEvent(event, false);
});
```

- [ ] **Step 6: Run ledger, API, and concurrency suites**

```powershell
pnpm --filter @poker/api test -- buyin-ledger.test.ts
pnpm --filter @poker/api test:e2e -- buyins.e2e-spec.ts
pnpm --filter @poker/api test:integration -- buyins-concurrency.integration-spec.ts
```

Expected: PASS; transaction retries never duplicate a financial event.

- [ ] **Step 7: Commit the buy-in ledger**

```powershell
git add apps/api/src/buyins apps/api/test/buyins.e2e-spec.ts apps/api/test/buyins-concurrency.integration-spec.ts apps/api/src/app.module.ts
git commit -m "feat: add append-only buy-in ledger"
```

---

### Task 9: Socket.IO Game Rooms, Presence, and Reconnect Snapshots

**Files:**
- Create: `apps/api/src/realtime/realtime.module.ts`
- Create: `apps/api/src/realtime/game.gateway.ts`
- Create: `apps/api/src/realtime/socket-session.adapter.ts`
- Create: `apps/api/src/realtime/presence.service.ts`
- Create: `apps/api/src/realtime/game-events.service.ts`
- Create: `packages/contracts/src/realtime.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/realtime.e2e-spec.ts`
- Modify: `apps/api/src/games/games.service.ts`
- Modify: `apps/api/src/buyins/buyins.service.ts`
- Modify: `apps/api/src/settings/settings.service.ts`
- Modify: `apps/api/src/users/users.service.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces client events: `game.snapshot`, `game.updated`, `presence.updated`, `rake-settings.updated`, `player-rake.updated`, and `server.error`.
- Consumes commands: `game.join { gameId, knownVersion }` and `game.leave { gameId }`.
- Produces `GameEventsService.publishCommittedGame(gameId)` for post-commit use by game, buy-in, and settlement services.
- Produces in-memory spectator presence only; it never changes financial tables.

- [ ] **Step 1: Write failing authenticated room tests**

```ts
it('rejects a socket without a valid session cookie', async () => {
  const socket = io(serverUrl, { transports: ['websocket'], autoConnect: false });
  const error = await waitForConnectError(socket);
  expect(error.message).toBe('UNAUTHENTICATED');
});

it('joins a game and receives a full snapshot newer than knownVersion', async () => {
  const socket = authenticatedSocket(userCookie);
  const snapshotPromise = once(socket, 'game.snapshot');
  socket.emit('game.join', { gameId: game.id, knownVersion: 0 });
  expect(await snapshotPromise).toMatchObject({ id: game.id, version: 1 });
});
```

Add a parameterized test that checks `presence.updated` contains a viewer before disconnect and omits the viewer after disconnect.

- [ ] **Step 2: Run the realtime suite and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- realtime.e2e-spec.ts
```

Expected: FAIL because the gateway is not registered.

- [ ] **Step 3: Authenticate the WebSocket handshake from the session cookie**

```ts
const rawToken = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
const authUser = await sessionService.authenticateRawToken(rawToken);
if (!authUser) throw new WsException('UNAUTHENTICATED');
socket.data.user = authUser;
```

Use the same session validation as HTTP; disabled users and revoked sessions cannot retain a socket.

- [ ] **Step 4: Implement room join, presence reference counts, and committed broadcasts**

`PresenceService` must count connections per `(gameId, userId)` so two tabs do not duplicate a spectator and closing one tab does not remove the other. Exclude users who already have a `gamePlayer` from the spectator list.

```ts
async publishCommittedGame(gameId: string) {
  const snapshot = await gamesService.getSnapshot(gameId);
  this.server.to(`game:${gameId}`).emit('game.updated', snapshot);
}
```

After a committed global rake change, emit `rake-settings.updated { version }` to every `ACTIVE` and `SETTLING` game room. After a committed user-rake change, locate the user's `active_player_lock` and emit `player-rake.updated { userId }` to that game room. Settlement clients refetch their preview on either event.

- [ ] **Step 5: Test reconnect and version recovery**

```ts
it('returns a full snapshot after events were missed', async () => {
  socket.disconnect();
  await buyinService.buy(game.id, user, 2, 'missed-event');
  socket.connect();
  const snapshot = await joinAndReceiveSnapshot(socket, game.id, 1);
  expect(snapshot.version).toBeGreaterThan(1);
  expect(snapshot.players[0].buyInAmount).toBe('600');
});
```

- [ ] **Step 6: Run realtime and buy-in regression tests**

```powershell
pnpm --filter @poker/api test:e2e -- realtime.e2e-spec.ts buyins.e2e-spec.ts
pnpm --filter @poker/api typecheck
```

Expected: PASS; no timer-tick event is emitted because elapsed time is client-derived.

- [ ] **Step 7: Commit realtime rooms**

```powershell
git add apps/api/src/realtime apps/api/src/games apps/api/src/buyins apps/api/test/realtime.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat: add realtime game rooms"
```

---

### Task 10: Settlement Draft, Editor Lease, and Live Preview

**Files:**
- Create: `apps/api/src/settlements/settlements.module.ts`
- Create: `apps/api/src/settlements/settlement-draft.controller.ts`
- Create: `apps/api/src/settlements/settlement-draft.service.ts`
- Create: `apps/api/src/settlements/settlement-draft.schema.ts`
- Create: `apps/api/src/settlements/settlement-preview.mapper.ts`
- Modify: `packages/contracts/src/settlement.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/settlement-draft.e2e-spec.ts`
- Test: `apps/api/test/settlement-lease.integration-spec.ts`
- Modify: `apps/api/src/games/games.service.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `GET /api/games/:id/settlement-draft`.
- Produces: `PUT /api/games/:id/settlement-draft` with optimistic `version`.
- Produces: `POST /api/games/:id/settlement-draft/takeover`.
- Produces: `POST /api/games/:id/settlement-preview`.
- Produces `SettlementDraftPayload` and `SettlementPreviewDto` consumed unchanged by the React wizard.

```ts
export interface SettlementDraftPayload {
  cashOutByPlayerId: Record<string, '' | MoneyJson>;
  roomFee: MoneyJson;
  roomPayerIds: string[];
  otherFee: MoneyJson;
  otherFeeNote: string;
  otherPayerIds: string[];
}

export interface SettlementBreakdownDto {
  totals: {
    buyIn: MoneyJson; cashOut: MoneyJson; roomFee: MoneyJson;
    otherFee: MoneyJson; rake: MoneyJson; final: MoneyJson;
  };
  players: Array<{
    playerId: string; nickname: string; buyIn: MoneyJson; cashOut: MoneyJson;
    rawProfit: MoneyJson; roomFeeShare: MoneyJson; otherFeeShare: MoneyJson;
    afterFeeProfit: MoneyJson; rakeAmount: MoneyJson; finalAmount: MoneyJson;
  }>;
}

export interface SettlementPreviewDto extends SettlementBreakdownDto {
  draftVersion: number;
  settingsVersion: number;
  previewReady: boolean;
  validationCode: string | null;
}
```

- [ ] **Step 1: Define the exact draft transport and write failing tests**

```ts
export const settlementDraftPayloadSchema = z.object({
  cashOutByPlayerId: z.record(z.string(), z.union([z.literal(''), nonNegativeMoneyJsonSchema])),
  roomFee: nonNegativeMoneyJsonSchema.default('380'),
  roomPayerIds: z.array(z.string()).default([]),
  otherFee: nonNegativeMoneyJsonSchema.default('0'),
  otherFeeNote: z.string().trim().max(100).default(''),
  otherPayerIds: z.array(z.string()).default([]),
}).superRefine((value, context) => {
  if (value.otherFee !== '0' && value.otherFeeNote.length === 0) {
    context.addIssue({ code: 'custom', path: ['otherFeeNote'], message: 'OTHER_FEE_NOTE_REQUIRED' });
  }
});
```

```ts
it('shows raw profit immediately after every cash-out entry', async () => {
  const response = await saveDraft({
    version: 1,
    payload: balancedPayload({ a: '3000', b: '400', c: '200' }),
  }).expect(200);
  expect(response.body.players.find((row) => row.playerId === 'a').rawProfit).toBe('1500');
});
```

- [ ] **Step 2: Run the draft test and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- settlement-draft.e2e-spec.ts
```

Expected: FAIL because draft routes do not exist.

- [ ] **Step 3: Implement default draft creation and optimistic save**

When a game enters `SETTLING`, create a draft with every participating player set to an empty cash-out string, room fee `380`, other fee `0`, and both payer lists empty. On the first save where all cash-outs are present and balanced, independently fill each still-empty nonzero-fee payer list with the raw-profit leader; after that, preserve every explicit payer edit. Saving must use `updateMany({ where: { gameId, version } })` and increment `version`; a zero update count returns `DRAFT_VERSION_CONFLICT` with the latest draft.

```ts
const saved = await prisma.settlementDraft.updateMany({
  where: { gameId, version: command.version, editorUserId: actor.id },
  data: {
    payload: command.payload,
    version: { increment: 1 },
    leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    updatedById: actor.id,
  },
});
if (saved.count !== 1) throw conflictWithLatest('DRAFT_VERSION_CONFLICT', await loadDraft(gameId));
```

- [ ] **Step 4: Write and implement the five-minute editor lease tests**

```ts
it('allows takeover only after lease expiry and audits it', async () => {
  await claimDraft(game.id, adminA);
  await takeoverDraft(game.id, adminB).expect(409);
  await prisma.settlementDraft.update({
    where: { gameId: game.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  await takeoverDraft(game.id, adminB).expect(200);
  expect(await prisma.auditLog.count({ where: { action: 'SETTLEMENT_TAKEN_OVER' } })).toBe(1);
});
```

Every successful edit extends the lease to `now + 5 minutes`.

- [ ] **Step 5: Implement live preview with current settings and user flags**

Load effective buy-ins, current user rake flags, and the current `system_settings` in one consistent read. Call `calculateSettlement` only when all cash-outs are present and balanced. Return raw profit before balance completion, but return `previewReady: false` and a stable validation code until the draft is valid.

```ts
return {
  draftVersion: draft.version,
  settingsVersion: settings.version,
  previewReady: true,
  totals: mapTotals(output),
  players: output.results.map(mapSettlementResult),
};
```

- [ ] **Step 6: Run draft, lease, and settlement package tests**

```powershell
pnpm --filter @poker/api test:e2e -- settlement-draft.e2e-spec.ts
pnpm --filter @poker/api test:integration -- settlement-lease.integration-spec.ts
pnpm --filter @poker/settlement test
```

Expected: PASS, including balance errors, fee-payer requirements, default top winner, fee notes, stale versions, and takeover audit.

- [ ] **Step 7: Commit settlement drafts**

```powershell
git add apps/api/src/settlements apps/api/test/settlement-draft.e2e-spec.ts apps/api/test/settlement-lease.integration-spec.ts apps/api/src/app.module.ts
git commit -m "feat: add recoverable settlement drafts"
```

---

### Task 11: Atomic Final Settlement and Immutable Single-Game History

**Files:**
- Create: `apps/api/src/settlements/settlement-finalization.controller.ts`
- Create: `apps/api/src/settlements/settlement-finalization.service.ts`
- Create: `apps/api/src/settlements/settlement-persistence.mapper.ts`
- Create: `apps/api/src/history/history.module.ts`
- Create: `apps/api/src/history/history.controller.ts`
- Create: `apps/api/src/history/history.service.ts`
- Create: `apps/api/src/history/history-policy.ts`
- Create: `packages/contracts/src/history.ts`
- Modify: `packages/contracts/src/settlement.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/settlement-finalization.e2e-spec.ts`
- Test: `apps/api/test/settlement-concurrency.integration-spec.ts`
- Test: `apps/api/test/history.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `POST /api/games/:id/settlement-finalize` with `{ draftVersion, settingsVersion }`.
- Produces: `GET /api/history?limit=10&cursor=...`, `GET /api/history/:gameId`; list limit defaults to 10 and is capped at 50.
- Produces one shared `SettlementDetailDto` for preview and history modes.
- Guarantees a single permanent settlement per game.

```ts
export interface SettlementDetailDto extends SettlementBreakdownDto {
  game: { id: string; name: string; startedAt: string; stoppedAt: string; durationSeconds: number };
  completedAt: string;
  settledByNickname: string;
  otherFeeNote: string;
  immutable: true;
}
```

- [ ] **Step 1: Write failing finalization invariants**

```ts
it('persists every result and releases active player locks atomically', async () => {
  const response = await finalize(game.id, { draftVersion: 4, settingsVersion: 2 }).expect(201);
  expect(response.body.players).toHaveLength(3);
  expect(await prisma.settlement.count({ where: { gameId: game.id } })).toBe(1);
  expect(await prisma.settlementResult.count({ where: { settlement: { gameId: game.id } } })).toBe(3);
  expect(await prisma.activePlayerLock.count()).toBe(0);
  expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('COMPLETED');
});

it('requires a refreshed preview after a live rake setting change', async () => {
  await updateSettingsVersion();
  await finalize(game.id, { draftVersion: 4, settingsVersion: 1 })
    .expect(409)
    .expect(({ body }) => expect(body.code).toBe('SETTINGS_VERSION_CONFLICT'));
});
```

- [ ] **Step 2: Run the finalization suite and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- settlement-finalization.e2e-spec.ts
```

Expected: FAIL because finalization is not implemented.

- [ ] **Step 3: Implement one serializable finalization transaction**

Inside the transaction: lock the game, draft, settings, players, and buy-in events; validate `SETTLING`, lease editor, draft version, settings version, balanced totals, and current rake flags; run `calculateSettlement`; insert settlement, results, and allocations; set `COMPLETED`; release locks; append audit.

```ts
await prisma.$transaction(async (tx) => {
  const context = await lockAndLoadFinalizationContext(tx, gameId);
  assertFinalizationVersions(context, command);
  const calculated = calculateSettlement(toDomainInput(context));
  await persistSettlement(tx, context, calculated, actor);
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
```

- [ ] **Step 4: Write and pass duplicate-submit concurrency tests**

```ts
it('creates exactly one settlement under duplicate submit', async () => {
  const outcomes = await Promise.allSettled([
    service.finalize(game.id, command, admin),
    service.finalize(game.id, command, admin),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await prisma.settlement.count({ where: { gameId: game.id } })).toBe(1);
});
```

- [ ] **Step 5: Implement history scope and immutable DTO mapping**

For ordinary users, history list and detail queries must join `game_players` on their user ID. Admin roles skip that scope. Lists sort by `completedAt DESC, id DESC`, use an opaque cursor, default to 10 rows, and cap requests at 50. Detail responses include every result row for an authorized game. Do not add any update or delete route for `settlements`, `settlement_results`, or `settlement_fee_allocations`.

```ts
const scope = actor.role === 'USER'
  ? { gamePlayers: { some: { userId: actor.id } } }
  : {};
const game = await prisma.game.findFirst({
  where: { id: gameId, status: 'COMPLETED', ...scope },
  include: { settlement: { include: { results: { include: { gamePlayer: true } }, feeAllocations: true } } },
});
if (!game) throw notFoundOrForbidden('HISTORY_SCOPE_DENIED');
```

- [ ] **Step 6: Run finalization, concurrency, and history tests**

```powershell
pnpm --filter @poker/api test:e2e -- settlement-finalization.e2e-spec.ts history.e2e-spec.ts
pnpm --filter @poker/api test:integration -- settlement-concurrency.integration-spec.ts
pnpm --filter @poker/api typecheck
```

Expected: PASS; `Σ rawProfit = 0` and `Σ finalAmount = -(fees + rake)` for every fixture.

- [ ] **Step 7: Commit permanent settlement and history**

```powershell
git add apps/api/src/settlements apps/api/src/history apps/api/test/settlement-finalization.e2e-spec.ts apps/api/test/settlement-concurrency.integration-spec.ts apps/api/test/history.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat: finalize immutable game settlements"
```

---

### Task 12: Authorized Multi-Game All-Player Aggregation

**Files:**
- Create: `apps/api/src/history/aggregation.controller.ts`
- Create: `apps/api/src/history/aggregation.service.ts`
- Create: `apps/api/src/history/history-filter.schema.ts`
- Modify: `packages/contracts/src/history.ts`
- Test: `apps/api/test/history-aggregation.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /api/history/aggregate` with `{ gameIds }`.
- Produces quick-filter resolution for recent 10, recent 30, last 30 days, last 90 days, and custom date range.
- Produces `AllPlayerAggregationDto` with game count, player count, and per-player component sums.

```ts
export interface AllPlayerAggregationDto {
  gameIds: string[];
  gameCount: number;
  playerCount: number;
  players: Array<{
    userId: string; nickname: string; avatarUrl: string; gamesPlayed: number;
    wins: number; losses: number; rawProfit: MoneyJson; roomFeeShare: MoneyJson;
    otherFeeShare: MoneyJson; afterFeeProfit: MoneyJson; rakeAmount: MoneyJson;
    finalAmount: MoneyJson;
    games: Array<{ gameId: string; gameName: string; completedAt: string; finalAmount: MoneyJson }>;
  }>;
}
```

- [ ] **Step 1: Write failing scope and sum tests**

```ts
it('returns every player from games selected by an ordinary participant', async () => {
  const response = await aggregateAs(userA, [game1.id, game2.id]).expect(200);
  expect(response.body.players.map((row) => row.nickname)).toEqual(expect.arrayContaining([
    '天一', '老王', '小陈',
  ]));
});

it('rejects an ordinary user selecting a game they did not play', async () => {
  await aggregateAs(userA, [unrelatedGame.id])
    .expect(403)
    .expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED'));
});
```

- [ ] **Step 2: Run aggregation tests and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- history-aggregation.e2e-spec.ts
```

Expected: FAIL because the endpoint does not exist.

- [ ] **Step 3: Implement authorized selection before aggregation**

First resolve and authorize the exact completed game IDs. Reject the entire request if any requested game is out of scope; never silently drop it. Then group stored immutable `settlement_results` by user ID.

```ts
const initial = {
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  rawProfit: 0n,
  roomFeeShare: 0n,
  otherFeeShare: 0n,
  afterFeeProfit: 0n,
  rakeAmount: 0n,
  finalAmount: 0n,
};
```

Count a win when `rawProfit > 0`, a loss when `< 0`, and neither when `= 0`. Sort by `finalAmount` descending, then normalized nickname.

- [ ] **Step 4: Add exact component-sum assertions**

```ts
expect(playerA).toMatchObject({
  rawProfit: '3420',
  roomFeeShare: '520',
  otherFeeShare: '140',
  afterFeeProfit: '2760',
  rakeAmount: '300',
  finalAmount: '2460',
});
expect(BigInt(playerA.afterFeeProfit)).toBe(
  BigInt(playerA.rawProfit) - BigInt(playerA.roomFeeShare) - BigInt(playerA.otherFeeShare),
);
```

- [ ] **Step 5: Run aggregation and history regression suites**

```powershell
pnpm --filter @poker/api test:e2e -- history-aggregation.e2e-spec.ts history.e2e-spec.ts
```

Expected: PASS for ordinary and admin scopes, all quick filters, empty selections, and deleted-user snapshots.

- [ ] **Step 6: Commit aggregation**

```powershell
git add apps/api/src/history apps/api/test/history-aggregation.e2e-spec.ts
git commit -m "feat: add all-player history aggregation"
```

---

### Task 13: React PWA Foundation, Auth Flow, and Midnight-Gold Design System

**Files:**
- Create: `apps/web/src/api/http-client.ts`
- Create: `apps/web/src/api/query-client.ts`
- Create: `apps/web/src/auth/AuthProvider.tsx`
- Create: `apps/web/src/auth/ProtectedRoute.tsx`
- Create: `apps/web/src/app/router.tsx`
- Create: `apps/web/src/app/AppShell.tsx`
- Create: `apps/web/src/components/{Button,Card,Money,Modal,Toast}.tsx`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/global.css`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Create: `apps/web/src/features/auth/ChangePasswordPage.tsx`
- Test: `apps/web/src/features/auth/LoginPage.test.tsx`
- Test: `apps/web/src/app/AppShell.test.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/vite.config.ts`

**Interfaces:**
- Produces: same-origin HTTP client that adds `X-CSRF-Token` and handles stable API errors.
- Produces: `useAuth()` with `user`, `csrfToken`, `login`, `logout`, and `refreshSession`.
- Produces protected routes and role gates consumed by every page.
- Produces money formatting that accepts only `MoneyJson`.

- [ ] **Step 1: Write failing login and forced-password route tests**

```tsx
it('redirects a forced-change user before rendering home', async () => {
  mockSession({ mustChangePassword: true });
  renderAppAt('/');
  expect(await screen.findByRole('heading', { name: '修改初始密码' })).toBeInTheDocument();
});

it('shows the server login error without clearing the username', async () => {
  server.use(loginFailure('INVALID_CREDENTIALS'));
  renderAppAt('/login');
  await userEvent.type(screen.getByLabelText('用户名'), 'tianyi');
  await userEvent.type(screen.getByLabelText('密码'), 'wrong-pass');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
  expect(screen.getByLabelText('用户名')).toHaveValue('tianyi');
});
```

- [ ] **Step 2: Run focused web tests and verify failure**

```powershell
pnpm --filter @poker/web test -- LoginPage.test.tsx AppShell.test.tsx
```

Expected: FAIL because router, provider, and pages are missing.

- [ ] **Step 3: Implement the same-origin client and auth provider**

```ts
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(init.method ?? 'GET') && csrfTokenStore.value) {
    headers.set('X-CSRF-Token', csrfTokenStore.value);
  }
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) throw await ApiError.fromResponse(response);
  return response.json() as Promise<T>;
}
```

- [ ] **Step 4: Implement tokens and reusable components**

```css
:root {
  --bg: #080b16;
  --surface: #171e34;
  --surface-raised: #222b4a;
  --gold: #f0ca73;
  --positive: #70e0a9;
  --negative: #ff8880;
  --expense: #e8a75d;
  --rake: #d8b4ff;
  --text: #f6f1e6;
  --muted: #929aaf;
  --radius-card: 16px;
  --touch-target: 44px;
}
```

`Money` must use `Intl.NumberFormat('zh-CN')` after converting the integer string to `bigint`, and expose positive/negative/neutral variants.

- [ ] **Step 5: Configure PWA manifest without offline mutations**

Cache only hashed static assets and the application shell. Set API and Socket.IO routes to `NetworkOnly`; show a global offline banner and disable write buttons while offline.

```ts
VitePWA({
  registerType: 'autoUpdate',
  manifest: { name: '德州计分', short_name: '德州计分', display: 'standalone', theme_color: '#080b16' },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,webp}'],
    runtimeCaching: [
      { urlPattern: /\/api\//, handler: 'NetworkOnly' },
      { urlPattern: /\/socket\.io\//, handler: 'NetworkOnly' },
    ],
  },
})
```

- [ ] **Step 6: Run tests, accessibility checks, and build**

```powershell
pnpm --filter @poker/web test
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web build
```

Expected: PASS; built manifest has the Chinese app name and installable 192/512 icons.

- [ ] **Step 7: Commit the PWA foundation**

```powershell
git add apps/web
git commit -m "feat: add mobile pwa foundation"
```

---

### Task 14: Home, Game Creation, User, Settings, and Profile Screens

**Files:**
- Create: `apps/web/src/features/home/HomePage.tsx`
- Create: `apps/web/src/features/home/{CurrentGameCard,RecentResultRow}.tsx`
- Create: `apps/web/src/features/games/CreateGamePage.tsx`
- Create: `apps/web/src/features/users/{UserListPage,UserFormPage,ResetPasswordDialog}.tsx`
- Create: `apps/web/src/features/settings/RakeSettingsPage.tsx`
- Create: `apps/web/src/features/profile/{ProfilePage,AvatarPicker,AvatarCropDialog}.tsx`
- Test: `apps/web/src/features/home/HomePage.test.tsx`
- Test: `apps/web/src/features/users/UserFormPage.test.tsx`
- Test: `apps/web/src/features/settings/RakeSettingsPage.test.tsx`
- Test: `apps/web/src/features/profile/AvatarPicker.test.tsx`
- Modify: `apps/web/src/app/router.tsx`

**Interfaces:**
- Consumes current games, history, user, avatar, and settings APIs.
- Produces all non-table admin/profile routes and respects role gates.

- [ ] **Step 1: Write failing home and role-gate tests**

```tsx
it('renders two current games and the latest ten results', async () => {
  mockCurrentGames(twoGames);
  mockHistory(makeHistory(12));
  renderAppAt('/');
  expect(await screen.findAllByRole('link', { name: /进入对局/ })).toHaveLength(2);
  expect(screen.getAllByTestId('recent-result')).toHaveLength(10);
});

it('does not expose create-user or rake-setting links to a normal user', async () => {
  mockSession({ role: 'USER' });
  renderAppAt('/profile');
  expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '抽成设置' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm --filter @poker/web test -- HomePage.test.tsx UserFormPage.test.tsx RakeSettingsPage.test.tsx AvatarPicker.test.tsx
```

Expected: FAIL because pages do not exist.

- [ ] **Step 3: Implement home and game creation**

Home shows personal recent-10 final amount summary, zero-to-two current cards, and recent history. The create form initializes `handPrice='300'`, `rakeEnabled=true`, and the server-generated name; its start action requires a second confirmation if it immediately opens the draft.

```tsx
export function HomePage() {
  const current = useQuery(currentGamesQuery());
  const history = useQuery(historyQuery({ recentGames: 10 }));
  return <AppShell>
    <PersonalSummary results={history.data?.games ?? []} />
    <CurrentGames games={current.data ?? []} />
    <RecentResults games={(history.data?.games ?? []).slice(0, 10)} />
  </AppShell>;
}
```

- [ ] **Step 4: Implement role-aware user and settings pages**

Use the permission matrix to construct role choices rather than merely hiding server-rejected options. Render stale settings conflicts by replacing form values with the returned latest version and requiring the user to submit again.

```tsx
const creatableRoles = currentUser.role === 'SUPER_ADMIN'
  ? ['SUPER_ADMIN', 'ADMIN', 'USER']
  : ['USER'];
```

- [ ] **Step 5: Implement avatar preset/upload/crop flow**

Crop in the browser to a square canvas, export PNG or WebP under 5 MiB, upload with progress, and keep the previous avatar visible until the server returns the new path.

```ts
export async function cropAvatar(image: HTMLImageElement, crop: CropRect): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  canvas.getContext('2d')!.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, 512, 512);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('AVATAR_ENCODE_FAILED')),
    'image/webp',
    0.9,
  ));
}
```

- [ ] **Step 6: Run focused tests and mobile component snapshots**

```powershell
pnpm --filter @poker/web test -- HomePage.test.tsx UserFormPage.test.tsx RakeSettingsPage.test.tsx AvatarPicker.test.tsx
pnpm --filter @poker/web typecheck
```

Expected: PASS at 360 px without horizontal overflow.

- [ ] **Step 7: Commit home and administration screens**

```powershell
git add apps/web/src/features apps/web/src/app/router.tsx
git commit -m "feat: add home and administration screens"
```

---

### Task 15: Live Round-Table UI, Buy-In Sheet, and Purchase Timeline

**Files:**
- Create: `apps/web/src/features/games/GamePage.tsx`
- Create: `apps/web/src/features/games/RoundTable.tsx`
- Create: `apps/web/src/features/games/Seat.tsx`
- Create: `apps/web/src/features/games/GameTimer.tsx`
- Create: `apps/web/src/features/games/SpectatorBar.tsx`
- Create: `apps/web/src/features/games/PurchaseTimeline.tsx`
- Create: `apps/web/src/features/buyins/BuyInSheet.tsx`
- Create: `apps/web/src/features/buyins/AdjustBuyInDialog.tsx`
- Create: `apps/web/src/api/game-socket.ts`
- Test: `apps/web/src/features/games/RoundTable.test.tsx`
- Test: `apps/web/src/features/games/GamePage.test.tsx`
- Test: `apps/web/src/features/buyins/BuyInSheet.test.tsx`
- Modify: `apps/web/src/app/router.tsx`

**Interfaces:**
- Consumes `GameSnapshotDto` and Socket.IO events from Task 9.
- Produces tabbed battle/timeline UI with a fixed buy button.
- Produces hand purchases `1,2,3,5,10` or manual `1–99`, plus latest logical buy adjustment `0–99`.

- [ ] **Step 1: Write failing seat-layout tests for 1, 8, and 12 players**

```tsx
it.each([1, 8, 12])('renders %i unique seats with self anchored at the bottom', (count) => {
  render(<RoundTable players={makePlayers(count)} selfUserId="self" />);
  expect(screen.getAllByTestId('table-seat')).toHaveLength(count);
  expect(screen.getByTestId('seat-self')).toHaveAttribute('data-anchor', 'bottom');
  expect(new Set(screen.getAllByTestId('table-seat').map((seat) => seat.getAttribute('data-position'))).size)
    .toBe(count);
});
```

- [ ] **Step 2: Run game UI tests and verify failure**

```powershell
pnpm --filter @poker/web test -- RoundTable.test.tsx GamePage.test.tsx BuyInSheet.test.tsx
```

Expected: FAIL because table components do not exist.

- [ ] **Step 3: Implement deterministic circular seat positions**

```ts
export function seatPosition(index: number, count: number, selfIndex: number) {
  const rotated = (index - selfIndex + count) % count;
  const angle = Math.PI / 2 + (rotated * Math.PI * 2) / count;
  return {
    left: `${50 + Math.cos(angle) * 43}%`,
    top: `${50 + Math.sin(angle) * 45}%`,
  };
}
```

Use compact cards for 9–12 players and always display avatar, nickname, effective hands, and negative buy-in value.

- [ ] **Step 4: Implement timer, tabs, socket recovery, and HTTP fallback**

`GameTimer` computes elapsed time from `startedAt` to `stoppedAt ?? serverNow`. Socket reconnect emits `game.join` with the known version. If the socket is disconnected for five seconds, poll `/games/:id/snapshot` every ten seconds and show a nonblocking connection banner.

```ts
useEffect(() => {
  if (socket.connected) return;
  const startFallback = window.setTimeout(() => setPolling(true), 5000);
  return () => window.clearTimeout(startFallback);
}, [socket.connected]);

useQuery({
  ...gameSnapshotQuery(gameId),
  refetchInterval: polling ? 10_000 : false,
});
```

- [ ] **Step 5: Implement buy and adjust interactions with idempotency keys**

```ts
const idempotencyKey = crypto.randomUUID();
await apiFetch(`/games/${gameId}/buyins`, {
  method: 'POST',
  body: JSON.stringify({ hands, idempotencyKey }),
  headers: { 'Content-Type': 'application/json' },
});
```

Disable the submit button while the same key is unresolved. On an uncertain network error, query/retry with the same key rather than generating a new one.

- [ ] **Step 6: Run UI, accessibility, and reconnect tests**

```powershell
pnpm --filter @poker/web test -- RoundTable.test.tsx GamePage.test.tsx BuyInSheet.test.tsx
pnpm --filter @poker/web typecheck
```

Expected: PASS; the table remains readable at 360×800 with 12 players.

- [ ] **Step 7: Commit the live game UI**

```powershell
git add apps/web/src/features/games apps/web/src/features/buyins apps/web/src/api/game-socket.ts apps/web/src/app/router.tsx
git commit -m "feat: add realtime round table ui"
```

---

### Task 16: Settlement Wizard, Reused Detail Page, and All-Player Summary UI

**Files:**
- Create: `apps/web/src/features/settlements/SettlementWizardPage.tsx`
- Create: `apps/web/src/features/settlements/CashOutStep.tsx`
- Create: `apps/web/src/features/settlements/ExpenseStep.tsx`
- Create: `apps/web/src/features/settlements/SettlementBreakdown.tsx`
- Create: `apps/web/src/features/settlements/SettlementPlayerCard.tsx`
- Create: `apps/web/src/features/history/HistoryPage.tsx`
- Create: `apps/web/src/features/history/GameSelectionPage.tsx`
- Create: `apps/web/src/features/history/SettlementDetailPage.tsx`
- Create: `apps/web/src/features/history/AllPlayerSummaryPage.tsx`
- Test: `apps/web/src/features/settlements/SettlementWizardPage.test.tsx`
- Test: `apps/web/src/features/settlements/SettlementBreakdown.test.tsx`
- Test: `apps/web/src/features/history/AllPlayerSummaryPage.test.tsx`
- Modify: `apps/web/src/app/router.tsx`

**Interfaces:**
- Consumes draft, preview, finalization, history, and aggregate endpoints.
- Produces one `SettlementBreakdown` used in preview mode and read-only history mode.
- Produces full-player component sums and per-player drilldown for selected games.

- [ ] **Step 1: Write failing cash-out and expense decision tests**

```tsx
it('shows raw profit beside each completed cash-out and blocks an unbalanced next step', async () => {
  renderSettlementWizard(unbalancedDraft);
  expect(await screen.findByText('牌局盈亏 +¥1,500')).toBeInTheDocument();
  expect(screen.getByText('还差 ¥200')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一步：费用分摊' })).toBeDisabled();
});

it('shows every candidate raw profit and preselects the top winner', async () => {
  renderExpenseStep(previewFixture);
  expect(screen.getByLabelText('天一，牌局盈亏 +¥1,500')).toBeChecked();
  expect(screen.getByText('老王')).toHaveTextContent('−¥500');
});
```

- [ ] **Step 2: Run focused settlement UI tests and verify failure**

```powershell
pnpm --filter @poker/web test -- SettlementWizardPage.test.tsx SettlementBreakdown.test.tsx AllPlayerSummaryPage.test.tsx
```

Expected: FAIL because these routes and components do not exist.

- [ ] **Step 3: Implement autosaved steps with draft-version conflict handling**

Debounce saves by 400 ms, display saved/saving/conflict state, and never advance based solely on client calculations. A `DRAFT_VERSION_CONFLICT` replaces local data with the server copy and tells the editor who currently owns the lease.

```ts
const saveDraft = useMutation({
  mutationFn: (command: SaveDraftCommand) => api.saveSettlementDraft(gameId, command),
  onSuccess: (saved) => form.reset(saved.payload),
  onError: (error) => {
    if (error.code === 'DRAFT_VERSION_CONFLICT') {
      form.reset(error.details.latest.payload);
      setConflictEditor(error.details.latest.editorNickname);
    }
  },
});
```

- [ ] **Step 4: Implement the three-level money hierarchy**

```tsx
<MoneyMetric label="牌局盈亏" value={player.rawProfit} tone="profit" />
<ExpenseMetric room={player.roomFeeShare} other={player.otherFeeShare} />
<MoneyMetric
  label={settlementLabel('费用后盈亏', player.afterFeeProfit, '抽成前')}
  value={player.afterFeeProfit}
  tone="after-fee"
/>
<RakeMetric value={player.rakeAmount} />
<MoneyMetric label={settlementLabel('最终金额', player.finalAmount, '最终')} value={player.finalAmount} tone="final" />
```

```ts
export function settlementLabel(prefix: string, value: MoneyJson, stage: string): string {
  const amount = BigInt(value);
  if (amount === 0n) return `${prefix} · ${stage}结清`;
  return `${prefix} · ${stage}${amount > 0n ? '应收' : '应付'}`;
}
```

Preview mode adds the irreversible warning and final button. History mode renders the same component without any mutation control.

- [ ] **Step 5: Implement history filters, game selection, and all-player cards**

Each player card displays games played, wins/losses, raw profit, room fee, other fee, after-fee profit, rake, and final amount. Sort final amount descending and allow expansion into per-game rows. Preserve ordinary-user selectable scope returned by the server.

```tsx
{aggregation.players.map((player) => <PlayerAggregateCard key={player.userId} player={player}>
  <MoneyMetric label="累计牌局盈亏" value={player.rawProfit} />
  <MoneyMetric label="累计房费" value={formatMoney(-BigInt(player.roomFeeShare))} />
  <MoneyMetric label="累计其他费用" value={formatMoney(-BigInt(player.otherFeeShare))} />
  <MoneyMetric label="累计费用后盈亏" value={player.afterFeeProfit} />
  <MoneyMetric label="累计抽成" value={formatMoney(-BigInt(player.rakeAmount))} />
  <MoneyMetric label="累计最终金额" value={player.finalAmount} />
</PlayerAggregateCard>)}
```

- [ ] **Step 6: Test settings-version refresh and immutable confirmation**

```tsx
it('requires a second preview after SETTINGS_VERSION_CONFLICT', async () => {
  server.use(finalizeConflict('SETTINGS_VERSION_CONFLICT'));
  renderSettlementWizard(readyDraft);
  await confirmPermanentSettlement();
  expect(await screen.findByText('抽成规则已变化，请重新核对')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认并永久锁定结算' })).toBeDisabled();
});
```

- [ ] **Step 7: Run the complete web suite and build**

```powershell
pnpm --filter @poker/web test
pnpm --filter @poker/web typecheck
pnpm --filter @poker/web build
```

Expected: PASS with no duplicate settlement breakdown implementation.

- [ ] **Step 8: Commit settlement and history UI**

```powershell
git add apps/web/src/features/settlements apps/web/src/features/history apps/web/src/app/router.tsx
git commit -m "feat: add settlement and all-player history ui"
```

---

### Task 17: Production Hardening, Single-Container Build, Backup, and Synology Guide

**Files:**
- Modify: `apps/api/src/common/errors/api-exception.filter.ts`
- Modify: `apps/api/src/common/errors/error-codes.ts`
- Create: `apps/api/src/common/security/security.module.ts`
- Create: `apps/api/src/health/readiness.controller.ts`
- Create: `apps/api/src/static/static.module.ts`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `docker-compose.test.yml`
- Create: `scripts/backup/backup.sh`
- Create: `scripts/backup/restore.sh`
- Create: `docs/deployment/synology.md`
- Create: `docs/deployment/backup-restore.md`
- Test: `apps/api/test/security.e2e-spec.ts`
- Test: `apps/api/test/readiness.e2e-spec.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces stable error body `{ code, message, requestId, details? }`.
- Produces `GET /api/health/live` and `GET /api/health/ready`.
- Produces one Docker image serving PWA, API, WebSocket, and avatars.
- Produces documented backup/restore commands with 14-day retention.

- [ ] **Step 1: Write failing security and readiness tests**

```ts
it('sets production security headers', async () => {
  const response = await request(app.getHttpServer()).get('/').expect(200);
  expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
});

it('returns not-ready when the database check fails', async () => {
  prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
  await request(app.getHttpServer())
    .get('/api/health/ready')
    .expect(503)
    .expect(({ body }) => expect(body.code).toBe('DATABASE_UNAVAILABLE'));
});
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
pnpm --filter @poker/api test:e2e -- security.e2e-spec.ts readiness.e2e-spec.ts
```

Expected: FAIL because headers, filters, and readiness are not implemented.

- [ ] **Step 3: Implement global errors, request IDs, trusted proxy, headers, and limits**

Use Helmet with a same-origin CSP that allows the Socket.IO WebSocket endpoint. Trust exactly one Synology proxy hop in production. Set JSON body limits, login throttles, upload limits, and structured log redaction. Map Prisma unique/version/deadlock failures to stable 409/503 codes without exposing SQL.

```ts
const express = app.getHttpAdapter().getInstance();
express.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: { defaultSrc: ["'self'"], connectSrc: ["'self'", 'wss:'], imgSrc: ["'self'", 'data:'] },
  },
  frameguard: { action: 'deny' },
}));
app.use(json({ limit: '256kb' }));
app.useGlobalFilters(new ApiExceptionFilter(requestIdService, logger));
```

- [ ] **Step 4: Create the multi-stage single-container image**

```dockerfile
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 AVATAR_ROOT=/data/avatars
RUN corepack enable
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @poker/api prisma migrate deploy && node apps/api/dist/main.js"]
```

The final Dockerfile may prune dev dependencies, but it must retain Prisma migration files, generated client, production packages, and `apps/web/dist`.

- [ ] **Step 5: Add production Compose with internal MySQL and avatar volume settings**

```yaml
services:
  app:
    image: poker-scorekeeper:local
    build: .
    restart: unless-stopped
    env_file: .env.production
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data/avatars:/data/avatars
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
```

Document production `DATABASE_URL` with host `192.168.10.248:3306` and local/test URL with `tianyi.wiki:8306`, using placeholders for credentials.

`docker-compose.test.yml` must be isolated and must not expose MySQL:

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: poker_scorekeeper_test
      MYSQL_USER: poker_test
      MYSQL_PASSWORD: poker_test
      MYSQL_ROOT_PASSWORD: test_root_only
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -ptest_root_only"]
      interval: 3s
      timeout: 3s
      retries: 30
  app:
    build: .
    environment:
      NODE_ENV: test
      DATABASE_URL: mysql://poker_test:poker_test@mysql:3306/poker_scorekeeper_test
      AVATAR_ROOT: /data/avatars
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      mysql:
        condition: service_healthy
    volumes:
      - ./data/test-avatars:/data/avatars
      - ./data/backups:/backups
      - ./data/restore:/restore
```

- [ ] **Step 6: Implement guarded backup and restore scripts**

`backup.sh` must create a timestamped MySQL dump and avatar archive, write checksums, fail on any command error, and delete only matching backup files older than 14 days within the configured backup directory. `restore.sh` must require explicit database name confirmation and verify checksums before import.

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${MYSQL_HOST:?MYSQL_HOST is required}"
: "${MYSQL_PORT:?MYSQL_PORT is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --single-transaction --quick --skip-lock-tables --no-tablespaces \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" "$MYSQL_DATABASE" \
  | gzip > "$BACKUP_DIR/mysql-$stamp.sql.gz"
tar -C /data -czf "$BACKUP_DIR/avatars-$stamp.tar.gz" avatars
sha256sum "$BACKUP_DIR/mysql-$stamp.sql.gz" "$BACKUP_DIR/avatars-$stamp.tar.gz" > "$BACKUP_DIR/checksums-$stamp.txt"
printf '%s\n' "$stamp" > "$BACKUP_DIR/latest-stamp"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mysql-*.sql.gz' -mtime +14 -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'avatars-*.tar.gz' -mtime +14 -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'checksums-*.txt' -mtime +14 -delete
```

```bash
#!/usr/bin/env bash
# scripts/backup/restore.sh
set -euo pipefail
: "${RESTORE_DATABASE:?RESTORE_DATABASE is required}"
: "${CONFIRM_RESTORE_DATABASE:?CONFIRM_RESTORE_DATABASE is required}"
: "${SQL_ARCHIVE:?SQL_ARCHIVE is required}"
: "${AVATAR_ARCHIVE:?AVATAR_ARCHIVE is required}"
: "${CHECKSUM_FILE:?CHECKSUM_FILE is required}"
[[ "$CONFIRM_RESTORE_DATABASE" == "$RESTORE_DATABASE" ]] || { echo 'database confirmation mismatch'; exit 2; }
[[ "$RESTORE_DATABASE" =~ ^[a-z][a-z0-9_]{2,63}$ ]] || { echo 'invalid restore database'; exit 2; }
(cd "$(dirname "$CHECKSUM_FILE")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
MYSQL_PWD="$MYSQL_PASSWORD" mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
  -e "CREATE DATABASE IF NOT EXISTS \`$RESTORE_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$SQL_ARCHIVE" | MYSQL_PWD="$MYSQL_PASSWORD" mysql \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" "$RESTORE_DATABASE"
mkdir -p "$RESTORE_AVATAR_ROOT"
[[ -z "$(find "$RESTORE_AVATAR_ROOT" -mindepth 1 -print -quit)" ]] || { echo 'avatar restore directory is not empty'; exit 2; }
tar -C "$RESTORE_AVATAR_ROOT" --strip-components=1 -xzf "$AVATAR_ARCHIVE"
```

- [ ] **Step 7: Build and smoke-test the image**

```powershell
docker compose -f docker-compose.test.yml up --build -d
docker compose -f docker-compose.test.yml exec app pnpm --filter @poker/api prisma migrate deploy
Invoke-RestMethod http://localhost:3000/api/health/ready
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=poker-scorekeeper.oci .
docker compose -f docker-compose.test.yml down
```

Expected: health returns `status=ok`; rebuilding the app container preserves the avatar fixture and MySQL data.

- [ ] **Step 8: Run security tests and validate documentation commands**

```powershell
pnpm --filter @poker/api test:e2e -- security.e2e-spec.ts readiness.e2e-spec.ts
pnpm build
```

Expected: PASS; docs never display a real password or publish ports 3000/3306 to all interfaces.

- [ ] **Step 9: Commit production hardening**

```powershell
git add apps/api/src/common apps/api/src/health apps/api/src/static apps/api/src/main.ts apps/api/src/app.module.ts Dockerfile docker-compose.yml docker-compose.test.yml scripts/backup docs/deployment
git commit -m "feat: add hardened synology deployment"
```

---

### Task 18: Full Mobile E2E, Backup Restore Drill, and Release Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/auth.spec.ts`
- Create: `tests/e2e/game-flow.spec.ts`
- Create: `tests/e2e/permissions.spec.ts`
- Create: `tests/e2e/history-aggregate.spec.ts`
- Create: `tests/e2e/avatar.spec.ts`
- Create: `tests/e2e/mobile-layout.spec.ts`
- Create: `tests/e2e/global-setup.ts`
- Create: `tests/e2e/support/fixtures.ts`
- Create: `tests/e2e/support/auth.ts`
- Create: `tests/e2e/support/games.ts`
- Create: `tests/e2e/support/settlement.ts`
- Create: `scripts/database/assert-restored-data.mjs`
- Create: `scripts/verify-release.ps1`
- Modify: `package.json`
- Modify: `docs/deployment/synology.md`

**Interfaces:**
- Produces root command `pnpm verify:release`.
- Produces Playwright projects for iPhone Safari-compatible WebKit and Android Chrome-compatible Chromium.
- Produces auditable release evidence covering migration, tests, image, backup, and restore.

- [ ] **Step 1: Write the failing full-game E2E scenario**

Install and pin the browser harness before creating the tests:

```powershell
pnpm add -Dw @playwright/test@^1.55.0
pnpm exec playwright install chromium webkit
```

```ts
test('admin creates, three players buy, settle, and aggregate the table', async ({ browser }) => {
  const admin = await loginContext(browser, 'admin');
  const playerA = await loginContext(browser, 'player-a');
  const playerB = await loginContext(browser, 'player-b');
  const game = await createAndStartGame(admin.page, { handPrice: '300', rakeEnabled: true });
  await buyHands(playerA.page, game.id, 5);
  await buyHands(playerB.page, game.id, 3);
  await adjustLatestBuy(playerA.page, game.id, 3);
  await buyHands(admin.page, game.id, 4);
  await settleBalancedGame(admin.page, game.id);
  await expectSettlementDetail(playerA.page, game.id, { showsAllPlayers: true });
  await expectAllPlayerAggregate(playerA.page, [game.id]);
});
```

- [ ] **Step 2: Run Playwright and verify failure**

```powershell
pnpm exec playwright test tests/e2e/game-flow.spec.ts
```

Expected: FAIL until fixtures, selectors, and complete deployed flow are wired.

- [ ] **Step 3: Implement deterministic fixture setup and every approved E2E path**

Seed only the `_test` database. Cover bootstrap/forced password, all role denials, two-table limit, 12-player table, one-player lock, duplicate idempotency, correction chain, lease takeover, live rake change, balanced settlement, immutable history, all-player aggregate, avatar upload/reset, and app restart recovery.

```ts
const scenarios: Array<{ name: string; run: (fixture: Fixture) => Promise<void> }> = [
  { name: 'bootstrap and forced password', run: verifyBootstrapPasswordFlow },
  { name: 'permissions', run: verifyRoleMatrix },
  { name: 'two tables and one player lock', run: verifyConcurrencyLimits },
  { name: 'buy correction and idempotency', run: verifyBuyinLedger },
  { name: 'lease and live rake', run: verifySettlementConcurrency },
  { name: 'immutable settlement and aggregate', run: verifyHistoryAndAggregate },
  { name: 'avatar lifecycle', run: verifyAvatarLifecycle },
  { name: 'restart recovery', run: verifyRestartRecovery },
];
for (const scenario of scenarios) test(scenario.name, async () => scenario.run(fixture));
```

- [ ] **Step 4: Add mobile visual/layout assertions**

```ts
for (const viewport of [{ width: 360, height: 800 }, { width: 430, height: 932 }]) {
  test(`12-seat table has no horizontal overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openTwelvePlayerGame(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('seat-self')).toBeVisible();
  });
}
```

- [ ] **Step 5: Execute a real backup and isolated restore drill**

Create data, run `backup.sh`, restore into a newly named `_restore_test` database and empty avatar directory, start the same image against the restored data, and assert that completed history and the avatar fixture load. Never restore over the active test or production schema.

```powershell
docker compose -f docker-compose.test.yml exec app sh scripts/backup/backup.sh
$restoreStamp = (Get-Content 'data\backups\latest-stamp').Trim()
docker compose -f docker-compose.test.yml exec `
  -e RESTORE_DATABASE=poker_scorekeeper_restore_test `
  -e CONFIRM_RESTORE_DATABASE=poker_scorekeeper_restore_test `
  -e "SQL_ARCHIVE=/backups/mysql-$restoreStamp.sql.gz" `
  -e "AVATAR_ARCHIVE=/backups/avatars-$restoreStamp.tar.gz" `
  -e "CHECKSUM_FILE=/backups/checksums-$restoreStamp.txt" `
  -e RESTORE_AVATAR_ROOT=/restore/avatars `
  app sh scripts/backup/restore.sh
docker compose -f docker-compose.test.yml exec app node scripts/database/assert-restored-data.mjs
```

- [ ] **Step 6: Implement the release verification script**

```powershell
$ErrorActionPreference = 'Stop'
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test
docker build -t poker-scorekeeper:verify .
Write-Output 'release verification passed'
```

Add the root script exactly:

```json
{
  "scripts": {
    "verify:release": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1"
  }
}
```

- [ ] **Step 7: Run fresh final verification and capture results**

```powershell
pnpm verify:release
git status --short
```

Expected: all unit, integration, E2E, type, build, migration, image, and restore checks pass; Git shows no unexpected generated or secret files.

- [ ] **Step 8: Commit final verification assets**

```powershell
git add playwright.config.ts tests/e2e scripts/verify-release.ps1 package.json docs/deployment/synology.md
git commit -m "test: verify complete mobile scorekeeper flow"
```

---

### Task 19: Synology Production Deployment and Live Acceptance

**Files:**
- Create: `scripts/database/production-preflight.mjs`
- Test: `scripts/database/production-preflight.test.ts`
- Create: `scripts/verify-production.mjs`
- Create: `docs/deployment/production-checklist.md`
- Create: `docs/deployment/production-verification.md`
- Modify: `docs/deployment/synology.md`

**Interfaces:**
- Produces a running production container that connects only to `192.168.10.248:3306/poker_scorekeeper`.
- Produces an HTTPS/WSS public endpoint supplied through `PUBLIC_ORIGIN`.
- Produces a secret-free production verification record with image digest, migration version, health result, backup result, and acceptance timestamp.

- [ ] **Step 1: Write a failing production-target validator test**

```ts
it.each([
  ['mysql://u:p@tianyi.wiki:8306/poker_scorekeeper', 'PRODUCTION_DATABASE_HOST_INVALID'],
  ['mysql://u:p@192.168.10.248:3306/poker_scorekeeper_test', 'PRODUCTION_DATABASE_NAME_INVALID'],
  ['mysql://u:p@192.168.10.248:3306/poker_scorekeeper', null],
])('validates %s', (databaseUrl, expectedCode) => {
  if (expectedCode) expect(() => assertProductionTarget(databaseUrl)).toThrow(expectedCode);
  else expect(() => assertProductionTarget(databaseUrl)).not.toThrow();
});
```

- [ ] **Step 2: Run the validator test and verify failure**

```powershell
pnpm exec vitest run scripts/database/production-preflight.test.ts
```

Expected: FAIL because `assertProductionTarget` does not exist.

- [ ] **Step 3: Implement read-only production preflight**

```js
export function assertProductionTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== '192.168.10.248' || Number(url.port) !== 3306) {
    throw new Error('PRODUCTION_DATABASE_HOST_INVALID');
  }
  if (url.pathname.slice(1) !== 'poker_scorekeeper') {
    throw new Error('PRODUCTION_DATABASE_NAME_INVALID');
  }
}
```

After target validation, connect without mutating and report server version, current database, `utf8mb4` availability, and whether the account can create/use `poker_scorekeeper`. Redact the password and full connection URL from all output.

- [ ] **Step 4: Prepare Synology directories and secrets without committing them**

Before this step, rotate the database password that was exposed in chat and obtain the new value from the user through a secure local environment file. On Synology:

```bash
install -d -m 750 /volume1/docker/poker-scorekeeper/data/avatars
install -d -m 750 /volume1/docker/poker-scorekeeper/data/backups
install -d -m 750 /volume1/docker/poker-scorekeeper/data/restore
chmod 600 /volume1/docker/poker-scorekeeper/.env.production
```

`.env.production` must set `DATABASE_URL` for `192.168.10.248:3306/poker_scorekeeper`, bootstrap-super-admin values, `SESSION_SECRET`, `CSRF_SECRET`, `PUBLIC_ORIGIN`, `AVATAR_ROOT=/data/avatars`, and backup MySQL variables. Do not print or copy its contents into logs.

- [ ] **Step 5: Preflight, create the database, migrate, and start the application**

```bash
cd /volume1/docker/poker-scorekeeper
docker compose run --rm app node scripts/database/production-preflight.mjs
docker compose run --rm app node scripts/database/create-database.mjs
docker compose run --rm app pnpm --filter @poker/api prisma migrate deploy
docker compose up -d --build
docker compose ps
```

Expected: app becomes healthy, the migration table matches the committed migration set, and no port other than loopback `3000` is published by Compose.

- [ ] **Step 6: Configure the user-owned public network edge**

In Synology reverse proxy, map the chosen HTTPS hostname to `http://127.0.0.1:3000`, enable WebSocket forwarding, forward real client IP headers, and attach a valid TLS certificate. The user configures router port forwarding for TCP 443 only. Do not forward 3000, 3306, or 8306.

```js
const health = await fetch(new URL('/api/health/ready', process.env.PUBLIC_ORIGIN));
if (!health.ok) throw new Error(`PUBLIC_HEALTH_FAILED_${health.status}`);
if (new URL(process.env.PUBLIC_ORIGIN).protocol !== 'https:') throw new Error('PUBLIC_ORIGIN_NOT_HTTPS');
if (!health.headers.get('strict-transport-security')) throw new Error('HSTS_MISSING');
```

- [ ] **Step 7: Run live smoke and reversible acceptance**

Use the bootstrap super admin to change the initial password, create one temporary ordinary user, create/start an empty test game, verify a phone joins its spectator room over WSS, void the zero-buy game, and logically delete the temporary user. Do not create a fake completed financial settlement in production.

```powershell
node scripts/verify-production.mjs
```

Expected: login, CSRF, user creation, game start, WebSocket presence, void, and logical delete all pass through the public HTTPS origin.

- [ ] **Step 8: Run first backup and record secret-free evidence**

```bash
docker compose exec app sh scripts/backup/backup.sh
docker image inspect poker-scorekeeper:local --format '{{.Id}}'
docker compose exec app pnpm --filter @poker/api prisma migrate status
```

Write only timestamps, statuses, migration names, image digest, and backup filenames/checksums to `docs/deployment/production-verification.md`. Exclude host credentials, cookies, user passwords, and connection URLs.

- [ ] **Step 9: Commit deployment verification documentation**

```powershell
git add scripts/database/production-preflight.mjs scripts/database/production-preflight.test.ts scripts/verify-production.mjs docs/deployment
git commit -m "docs: verify synology production deployment"
```

---

## Spec Coverage Map

| Approved design section | Implemented and verified by |
|---|---|
| Product goal, single-container architecture, environment split | Tasks 1, 3, 17–19 |
| Accounts, roles, password sessions, last-super-admin protection | Tasks 4, 5, 13, 14, 18 |
| Preset and uploaded avatars | Tasks 5, 14, 18 |
| Midnight-gold mobile PWA and navigation | Tasks 13–16, 18 |
| Game lifecycle, two-table limit, 12 seats, one-table player lock | Tasks 7–9, 15, 18 |
| Append-only buy-ins, corrections, and idempotency | Tasks 8, 9, 15, 18 |
| Settlement formulas, rounding, live rake, leases, immutable finalization | Tasks 2, 6, 10, 11, 16, 18 |
| Single-game history and full-table visibility | Tasks 11, 16, 18 |
| Authorized all-player aggregation | Tasks 12, 16, 18 |
| MySQL schema, indexes, migrations, and transaction recovery | Tasks 3, 7–12, 17, 18 |
| Security, audit, public reverse proxy boundary | Tasks 4–6, 17, 18 |
| Backup, restore, Synology deployment, mobile browser acceptance | Tasks 17–19 |

Self-review result: every approved design section maps to at least one implementation task and one verification path; no independent subsystem remains unplanned.

---

## Final Implementation Review Gate

After Task 19, invoke `superpowers:verification-before-completion`, run `pnpm verify:release` from a clean working tree, inspect the generated Docker image and migration status, and compare every section of the approved design against the delivered routes and screens. Then invoke `superpowers:requesting-code-review` before choosing an integration path with `superpowers:finishing-a-development-branch`.
