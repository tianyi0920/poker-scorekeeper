import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { SettlementDraftPayload } from '@poker/contracts';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import {
  BuyinEventType,
  GameStatus,
  Role,
  type Game,
  type GamePlayer,
  type User
} from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GameEventsService } from '../src/realtime/game-events.service.js';
import { defaultSettlementDraftPayload } from '../src/settlements/settlement-draft.schema.js';
import { SettlementDraftService } from '../src/settlements/settlement-draft.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `settlement-lease-${runId}`;

interface Fixture {
  game: Game;
  players: [GamePlayer, GamePlayer];
  payload: SettlementDraftPayload;
}

interface SeedFixtureOptions {
  expired?: boolean;
  creator?: User;
}

type Outcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

function captureOutcome<T>(
  operation: Promise<T>,
  onSettled: () => void = () => undefined
): Promise<Outcome<T>> {
  return operation.then(
    (value) => {
      onSettled();
      return { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      onSettled();
      return { status: 'rejected', reason };
    }
  );
}

async function waitForLock(
  locked: Promise<void>,
  blockerOutcome: Promise<Outcome<void>>
): Promise<void> {
  const result = await Promise.race([
    locked.then(() => ({ status: 'locked' as const })),
    blockerOutcome.then((outcome) => ({ status: 'blocker-settled' as const, outcome }))
  ]);
  if (result.status === 'locked') return;
  if (result.outcome.status === 'rejected') throw result.outcome.reason;
  throw new Error('Game-lock blocker settled before publishing its lock barrier');
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function authUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    avatarKind: user.avatarKind,
    avatarValue: user.avatarValue
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.sequential('settlement draft lease concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: SettlementDraftService;
  let events: GameEventsService;
  let adminA: User;
  let adminB: User;
  let adminC: User;
  let playerA: User;
  let playerB: User;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `租约-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash: 'not-used-by-service-integration-tests',
        role,
        avatarValue: 'preset-05'
      }
    });
  }

  async function seedFixture(
    suffix: string,
    { expired = false, creator = adminA }: SeedFixtureOptions = {}
  ): Promise<Fixture> {
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.SETTLING,
        version: 2,
        createdById: creator.id,
        startedAt: new Date(Date.now() - 60_000),
        stoppedAt: new Date()
      }
    });
    const players: GamePlayer[] = [];
    for (const [index, user] of [playerA, playerB].entries()) {
      const player = await prisma.gamePlayer.create({
        data: {
          gameId: game.id,
          userId: user.id,
          nicknameSnapshot: user.nickname,
          avatarKindSnapshot: user.avatarKind,
          avatarValueSnapshot: user.avatarValue,
          seatNo: index + 1,
          firstBuyinAt: new Date()
        }
      });
      const eventId = randomBytes(15).toString('hex');
      await prisma.buyinEvent.create({
        data: {
          id: eventId,
          gameId: game.id,
          gamePlayerId: player.id,
          actorUserId: user.id,
          type: BuyinEventType.BUY,
          logicalBuyId: eventId,
          previousHands: null,
          newHands: 1,
          handsDelta: 1,
          gameVersion: index + 2,
          idempotencyKey: `${prefix}-${suffix}-${index}`
        }
      });
      await prisma.activePlayerLock.create({ data: { gameId: game.id, userId: user.id } });
      players.push(player);
    }
    const typedPlayers = players as Fixture['players'];
    const initial = defaultSettlementDraftPayload(typedPlayers.map(({ id }) => id));
    await prisma.settlementDraft.create({
      data: {
        gameId: game.id,
        payload: initial,
        editorUserId: adminA.id,
        updatedById: adminA.id,
        leaseExpiresAt: new Date(Date.now() + (expired ? -1_000 : 300_000))
      }
    });
    return {
      game,
      players: typedPlayers,
      payload: {
        ...initial,
        cashOutByPlayerId: {
          [typedPlayers[0].id]: '600',
          [typedPlayers[1].id]: '0'
        },
        roomFee: '0'
      }
    };
  }

  async function cleanGames(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const draftIds = (await prisma.settlementDraft.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    })).map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: gameIds } },
          ...(draftIds.length === 0
            ? []
            : [{ entityType: 'SETTLEMENT_DRAFT', entityId: { in: draftIds } }])
        ]
      }
    });
    await prisma.settlementDraft.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `租约根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp();
    prisma = app.get(PrismaService);
    drafts = app.get(SettlementDraftService);
    events = app.get(GameEventsService);
    await app.init();
    adminA = await seedUser('admin-a', Role.ADMIN);
    adminB = await seedUser('admin-b', Role.ADMIN);
    adminC = await seedUser('admin-c', Role.ADMIN);
    playerA = await seedUser('player-a', Role.USER);
    playerB = await seedUser('player-b', Role.USER);
  }, 30_000);

  beforeEach(async () => {
    await cleanGames();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanGames();
      const users = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const userIds = users.map(({ id }) => id);
      if (userIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('lets exactly one same-version save commit', async () => {
    const fixture = await seedFixture('save-race');
    const draft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id },
      select: { id: true }
    });
    const outcomes = await Promise.allSettled([
      drafts.save(fixture.game.id, authUser(adminA), { version: 1, payload: fixture.payload }),
      drafts.save(fixture.game.id, authUser(adminA), { version: 1, payload: fixture.payload })
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { code: 'DRAFT_VERSION_CONFLICT' } });
    await expect(prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } }))
      .resolves.toMatchObject({ version: 2 });
    await expect(prisma.auditLog.count({
      where: {
        action: 'SETTLEMENT_DRAFT_UPDATED',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: draft.id
      }
    })).resolves.toBe(1);
  });

  it('lets exactly one administrator take an expired lease', async () => {
    const fixture = await seedFixture('takeover-race', { expired: true });
    const draft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id },
      select: { id: true }
    });
    const outcomes = await Promise.allSettled([
      drafts.takeover(fixture.game.id, authUser(adminB)),
      drafts.takeover(fixture.game.id, authUser(adminC))
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { code: 'DRAFT_LEASE_ACTIVE' } });
    const stored = await prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } });
    expect([adminB.id, adminC.id]).toContain(stored.editorUserId);
    expect(stored.version).toBe(2);
    await expect(prisma.auditLog.count({
      where: {
        action: 'SETTLEMENT_TAKEN_OVER',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: draft.id
      }
    })).resolves.toBe(1);
  });

  it('rejects a demoted non-owner editor after waiting for the game lock', async () => {
    const fixture = await seedFixture('non-owner-editor-demotion', { creator: adminB });
    const draft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id },
      select: { id: true }
    });
    let gameLocked!: () => void;
    let releaseGame!: () => void;
    const locked = new Promise<void>((resolve) => { gameLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGame = resolve; });
    let blockerOutcome: Promise<Outcome<void>> | undefined;
    let saveOutcome: Promise<Outcome<Awaited<ReturnType<SettlementDraftService['save']>>>> | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      blockerOutcome = captureOutcome(prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM games WHERE id = ${fixture.game.id} FOR UPDATE
        `;
        gameLocked();
        await release;
        await transaction.user.update({ where: { id: adminA.id }, data: { role: Role.USER } });
      }, { timeout: 10_000, maxWait: 5_000 }));
      await waitForLock(locked, blockerOutcome);

      let settled = false;
      saveOutcome = captureOutcome(drafts.save(
        fixture.game.id,
        authUser(adminA),
        { version: 1, payload: fixture.payload }
      ), () => { settled = true; });
      await delay(200);
      expect(settled).toBe(false);
      releaseGame();
      const blockerResult = await blockerOutcome;
      if (blockerResult.status === 'rejected') throw blockerResult.reason;

      await expect(saveOutcome).resolves.toMatchObject({
        status: 'rejected',
        reason: { code: 'FORBIDDEN' }
      });
      await expect(prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } }))
        .resolves.toMatchObject({ version: 1, editorUserId: adminA.id });
      await expect(prisma.auditLog.count({
        where: {
          action: 'SETTLEMENT_DRAFT_UPDATED',
          entityType: 'SETTLEMENT_DRAFT',
          entityId: draft.id
        }
      }))
        .resolves.toBe(0);
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    } finally {
      releaseGame();
      await Promise.allSettled([
        ...(blockerOutcome === undefined ? [] : [blockerOutcome]),
        ...(saveOutcome === undefined ? [] : [saveOutcome])
      ]);
      try {
        adminA = await prisma.user.update({ where: { id: adminA.id }, data: { role: Role.ADMIN } });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
  }, 15_000);

  it('lets a demoted game creator save after waiting for the game lock', async () => {
    const fixture = await seedFixture('creator-editor-demotion');
    const draft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id },
      select: { id: true }
    });
    let gameLocked!: () => void;
    let releaseGame!: () => void;
    const locked = new Promise<void>((resolve) => { gameLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGame = resolve; });
    let blockerOutcome: Promise<Outcome<void>> | undefined;
    let saveOutcome: Promise<Outcome<Awaited<ReturnType<SettlementDraftService['save']>>>> | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      blockerOutcome = captureOutcome(prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM games WHERE id = ${fixture.game.id} FOR UPDATE
        `;
        gameLocked();
        await release;
        await transaction.user.update({ where: { id: adminA.id }, data: { role: Role.USER } });
      }, { timeout: 10_000, maxWait: 5_000 }));
      await waitForLock(locked, blockerOutcome);

      let settled = false;
      saveOutcome = captureOutcome(drafts.save(
        fixture.game.id,
        authUser(adminA),
        { version: 1, payload: fixture.payload }
      ), () => { settled = true; });
      await delay(200);
      expect(settled).toBe(false);
      releaseGame();
      const blockerResult = await blockerOutcome;
      if (blockerResult.status === 'rejected') throw blockerResult.reason;

      await expect(saveOutcome).resolves.toMatchObject({
        status: 'fulfilled',
        value: { version: 2, editorUserId: adminA.id }
      });
      await expect(prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } }))
        .resolves.toMatchObject({ version: 2, editorUserId: adminA.id, updatedById: adminA.id });
      await expect(prisma.auditLog.count({
        where: {
          action: 'SETTLEMENT_DRAFT_UPDATED',
          entityType: 'SETTLEMENT_DRAFT',
          entityId: draft.id,
          actorUserId: adminA.id
        }
      }))
        .resolves.toBe(1);
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    } finally {
      releaseGame();
      await Promise.allSettled([
        ...(blockerOutcome === undefined ? [] : [blockerOutcome]),
        ...(saveOutcome === undefined ? [] : [saveOutcome])
      ]);
      try {
        adminA = await prisma.user.update({ where: { id: adminA.id }, data: { role: Role.ADMIN } });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
  }, 15_000);

  it('broadcasts only after the draft commit is visible', async () => {
    const fixture = await seedFixture('postcommit');
    let observedVersion: number | undefined;
    const observe = vi.spyOn(events, 'publishCommittedGame').mockImplementationOnce(async () => {
      observedVersion = (await prisma.settlementDraft.findUniqueOrThrow({
        where: { gameId: fixture.game.id }
      })).version;
    });
    try {
      await drafts.save(
        fixture.game.id,
        authUser(adminA),
        { version: 1, payload: fixture.payload }
      );
      expect(observedVersion).toBe(2);
    } finally {
      observe.mockRestore();
    }
  });

  it('keeps the committed draft when its best-effort broadcast fails', async () => {
    const fixture = await seedFixture('broadcast-failure');
    const draft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id },
      select: { id: true }
    });
    const fail = vi.spyOn(events, 'publishCommittedGame')
      .mockRejectedValueOnce(new Error('injected broadcast failure'));
    try {
      await expect(drafts.save(
        fixture.game.id,
        authUser(adminA),
        { version: 1, payload: fixture.payload }
      )).resolves.toMatchObject({ version: 2 });
    } finally {
      fail.mockRestore();
    }
    await expect(prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } }))
      .resolves.toMatchObject({ version: 2 });
    await expect(prisma.auditLog.count({
      where: {
        action: 'SETTLEMENT_DRAFT_UPDATED',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: draft.id
      }
    }))
      .resolves.toBe(1);
  });
});
