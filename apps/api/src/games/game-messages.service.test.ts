import type { AuthUser } from '../common/auth/auth-user.js';
import { GameStatus, Role } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GameEventsService } from '../realtime/game-events.service.js';
import { GameMessagesService } from './game-messages.service.js';

const actor: AuthUser = {
  id: 'user-1',
  username: 'user-1',
  nickname: '西西',
  role: Role.USER,
  mustChangePassword: false,
  avatarKind: 'PRESET',
  avatarValue: 'preset-13'
};

function createFixture() {
  const games = new Map<string, { id: string; status: GameStatus; players: Array<{ userId: string }> }>([
    ['game-1', { id: 'game-1', status: GameStatus.ACTIVE, players: [] }],
    ['game-2', { id: 'game-2', status: GameStatus.ACTIVE, players: [] }],
    ['settling-game', { id: 'settling-game', status: GameStatus.SETTLING, players: [] }],
    ['draft-game', { id: 'draft-game', status: GameStatus.DRAFT, players: [] }]
  ]);
  const prisma = {
    game: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => games.get(where.id) ?? null)
    }
  } as unknown as PrismaService;
  const events = {
    publishGameMessage: vi.fn(async () => undefined)
  } as unknown as GameEventsService;
  const service = new GameMessagesService(prisma, events);
  return { service, events, prisma };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function lifecycleTokenCount(service: GameMessagesService): number {
  return (service as unknown as {
    lifecycleTokensByGame: Map<string, unknown>;
  }).lifecycleTokensByGame.size;
}

describe('GameMessagesService', () => {
  it('stores, trims, and returns an authorized active-game message', async () => {
    // Break caught: accepted speech is lost, untrimmed, or not published to live clients.
    const { service, events } = createFixture();

    const created = await service.create('game-1', actor, { text: '  马上到  ' });

    expect(created).toMatchObject({
      gameId: 'game-1',
      userId: actor.id,
      nickname: '西西',
      avatarUrl: '/avatars/preset-13.webp',
      text: '马上到'
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await service.list('game-1', actor)).messages).toEqual([created]);
    expect(events.publishGameMessage).toHaveBeenCalledExactlyOnceWith(
      'game-1',
      created,
      expect.any(Function)
    );
  });

  it('keeps only the latest fifty messages per game', async () => {
    // Break caught: a long-running game grows process memory without the agreed bound.
    const { service } = createFixture();

    for (let index = 0; index < 51; index += 1) {
      await service.create('game-1', actor, { text: `消息${index}` });
    }

    const messages = (await service.list('game-1', actor)).messages;
    expect(messages).toHaveLength(50);
    expect(messages[0]?.text).toBe('消息1');
    expect(messages.at(-1)?.text).toBe('消息50');
  });

  it('isolates games and clears only the requested game', async () => {
    // Break caught: ending one table erases messages from another live table.
    const { service } = createFixture();
    await service.create('game-1', actor, { text: '第一桌' });
    await service.create('game-2', actor, { text: '第二桌' });

    service.clear('game-1');

    expect((await service.list('game-1', actor)).messages).toEqual([]);
    expect((await service.list('game-2', actor)).messages).toHaveLength(1);
  });

  it('does not restore or publish a message when game cleanup wins an in-flight authorization race', async () => {
    // Break caught: a sender that started before settlement can repopulate the cleared in-memory table afterward.
    const { service, events, prisma } = createFixture();
    const authorization = deferred<{ id: string; status: GameStatus; players: Array<{ userId: string }> }>();
    vi.mocked(prisma.game.findUnique).mockReturnValueOnce(authorization.promise as never);

    const sending = service.create('game-1', actor, { text: '迟到消息' });
    service.clear('game-1');
    authorization.resolve({ id: 'game-1', status: GameStatus.ACTIVE, players: [] });

    await expect(sending).rejects.toMatchObject({ code: 'GAME_STATE_CONFLICT' });
    expect(events.publishGameMessage).not.toHaveBeenCalled();
    expect((await service.list('game-1', actor)).messages).toEqual([]);
  });

  it('uses the current uploaded avatar and keeps a committed in-memory message if broadcast fails', async () => {
    // Break caught: old snapshot avatars are shown or a transient socket outage turns a successful send into failure.
    const { service, events } = createFixture();
    vi.mocked(events.publishGameMessage).mockRejectedValueOnce(new Error('socket unavailable'));
    const uploadActor = { ...actor, avatarKind: 'UPLOAD' as const, avatarValue: 'avatar.webp' };

    const created = await service.create('game-1', uploadActor, { text: '看这里' });

    expect(created.avatarUrl).toBe('/avatars/uploads/avatar.webp');
    expect((await service.list('game-1', uploadActor)).messages).toEqual([created]);
  });

  it('enforces game visibility and active state before reading or sending', async () => {
    // Break caught: missing/private/ended games become an unauthorised chat channel.
    const { service } = createFixture();

    await expect(service.list('missing-game', actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.list('draft-game', actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.create('settling-game', actor, { text: '还在吗' }))
      .rejects.toMatchObject({ code: 'GAME_STATE_CONFLICT' });
    await expect(service.list('settling-game', actor)).resolves.toEqual({
      gameId: 'settling-game',
      messages: []
    });
  });

  it('releases lifecycle tokens after missing, forbidden, and late non-active sends', async () => {
    // Break caught: rejected sends recreate permanent per-game tokens after settlement cleanup.
    const { service } = createFixture();

    service.clear('settling-game');
    await expect(service.create('settling-game', actor, { text: '迟到了' }))
      .rejects.toMatchObject({ code: 'GAME_STATE_CONFLICT' });
    await expect(service.create('missing-game', actor, { text: '有人吗' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.create('draft-game', actor, { text: '看不到' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(lifecycleTokenCount(service)).toBe(0);
  });

  it('does not let one failed concurrent send invalidate another authorized send', async () => {
    // Break caught: naïvely deleting a shared token on one rejection cancels another in-flight sender.
    const { service, prisma } = createFixture();
    const missingAuthorization = deferred<null>();
    const activeAuthorization = deferred<{
      id: string;
      status: GameStatus;
      players: Array<{ userId: string }>;
    }>();
    vi.mocked(prisma.game.findUnique)
      .mockReturnValueOnce(missingAuthorization.promise as never)
      .mockReturnValueOnce(activeAuthorization.promise as never);

    const rejected = service.create('game-1', actor, { text: '失败请求' });
    const accepted = service.create('game-1', actor, { text: '有效请求' });
    missingAuthorization.resolve(null);
    await expect(rejected).rejects.toMatchObject({ code: 'NOT_FOUND' });
    activeAuthorization.resolve({ id: 'game-1', status: GameStatus.ACTIVE, players: [] });

    await expect(accepted).resolves.toMatchObject({ text: '有效请求' });
    expect(lifecycleTokenCount(service)).toBe(0);
  });
});
