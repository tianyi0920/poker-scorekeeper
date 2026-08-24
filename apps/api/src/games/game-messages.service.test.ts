import type { GameMessageDto } from '@poker/contracts';
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
    publishGameMessage: vi.fn(async (_gameId: string, _message: GameMessageDto) => undefined)
  } as unknown as GameEventsService;
  const service = new GameMessagesService(prisma, events);
  return { service, events };
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
    expect(events.publishGameMessage).toHaveBeenCalledExactlyOnceWith('game-1', created);
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
});
