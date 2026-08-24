import type { AuthenticatedSession } from '../common/auth/auth-user.js';
import { Role } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PresenceService } from './presence.service.js';
import { GameEventsService } from './game-events.service.js';
import type { SocketSessionAdapter } from './socket-session.adapter.js';
import type { Server } from 'socket.io';
import type { GameMessageDto } from '@poker/contracts';
import { GameStatus } from '../generated/prisma/client.js';

interface FakeSocket {
  id: string;
  data: { gameId?: string };
  emit: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function authenticatedSession(userId: string): AuthenticatedSession {
  return {
    id: `session-${userId}`,
    csrfToken: `csrf-${userId}`,
    user: {
      id: userId,
      username: userId,
      nickname: userId,
      role: Role.USER,
      mustChangePassword: false,
      avatarKind: 'PRESET',
      avatarValue: 'preset-13'
    }
  };
}

function fakeSocket(id: string, gameId: string | undefined = 'game-1'): FakeSocket {
  return {
    id,
    data: gameId === undefined ? {} : { gameId },
    emit: vi.fn(),
    leave: vi.fn(async () => undefined),
    disconnect: vi.fn()
  };
}

function fakeServer(
  rooms: Map<string, Set<string>>,
  sockets: Map<string, FakeSocket>
): Server {
  return {
    sockets: {
      adapter: { rooms },
      sockets
    }
  } as unknown as Server;
}

function createFixture() {
  const prisma = {
    game: {
      findUnique: vi.fn(),
      findMany: vi.fn()
    },
    activePlayerLock: { findUnique: vi.fn() }
  } as unknown as PrismaService;
  const presence = {
    clear: vi.fn(),
    list: vi.fn(),
    remove: vi.fn()
  } as unknown as PresenceService;
  const socketSessions = {
    revalidate: vi.fn()
  } as unknown as SocketSessionAdapter;
  return {
    prisma,
    presence,
    socketSessions,
    service: new GameEventsService(prisma, presence, socketSessions)
  };
}

describe('GameEventsService.publishDeletedGame', () => {
  it('revalidates and emits exactly once only to sockets in the deleted game room before leaving', async () => {
    // Break caught: a deletion leaks across rooms, duplicates, queries an absent game, or leaves stale room state.
    const fixture = createFixture();
    const first = fakeSocket('socket-1');
    const second = fakeSocket('socket-2', 'another-game');
    const unrelated = fakeSocket('socket-3', 'game-2');
    fixture.service.bindServer(fakeServer(
      new Map([
        ['game:game-1', new Set([first.id, second.id])],
        ['game:game-2', new Set([unrelated.id])]
      ]),
      new Map([[first.id, first], [second.id, second], [unrelated.id, unrelated]])
    ));
    vi.mocked(fixture.socketSessions.revalidate).mockImplementation(async (socket) =>
      authenticatedSession(`user-${socket.id}`)
    );

    await fixture.service.publishDeletedGame('game-1');

    const event = { gameId: 'game-1', reason: 'HARD_DELETED' };
    expect(first.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', event);
    expect(second.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', event);
    expect(unrelated.emit).not.toHaveBeenCalled();
    expect(first.leave).toHaveBeenCalledExactlyOnceWith('game:game-1');
    expect(second.leave).toHaveBeenCalledExactlyOnceWith('game:game-1');
    expect(first.emit.mock.invocationCallOrder[0]).toBeLessThan(first.leave.mock.invocationCallOrder[0]!);
    expect(second.emit.mock.invocationCallOrder[0]).toBeLessThan(second.leave.mock.invocationCallOrder[0]!);
    expect(first.data.gameId).toBeUndefined();
    expect(second.data.gameId).toBe('another-game');
    expect(unrelated.data.gameId).toBe('game-2');
    expect(fixture.socketSessions.revalidate).toHaveBeenCalledTimes(2);
    expect(fixture.presence.clear).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(fixture.prisma.game.findUnique).not.toHaveBeenCalled();
    expect(fixture.prisma.game.findMany).not.toHaveBeenCalled();
  });

  it('disconnects null and failed revalidations without emitting while continuing with other sockets', async () => {
    // Break caught: a revoked/broken session receives the event or aborts delivery to a later valid socket.
    const fixture = createFixture();
    const revoked = fakeSocket('revoked');
    const failed = fakeSocket('failed');
    const valid = fakeSocket('valid');
    fixture.service.bindServer(fakeServer(
      new Map([['game:game-1', new Set([revoked.id, failed.id, valid.id])]]),
      new Map([[revoked.id, revoked], [failed.id, failed], [valid.id, valid]])
    ));
    vi.mocked(fixture.socketSessions.revalidate).mockImplementation(async (socket) => {
      if (socket.id === revoked.id) return null;
      if (socket.id === failed.id) throw new Error('session store unavailable');
      return authenticatedSession('valid-user');
    });

    await fixture.service.publishDeletedGame('game-1');

    expect(revoked.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    expect(failed.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    expect(revoked.emit).not.toHaveBeenCalled();
    expect(failed.emit).not.toHaveBeenCalled();
    expect(valid.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', {
      gameId: 'game-1',
      reason: 'HARD_DELETED'
    });
    expect(valid.leave).toHaveBeenCalledExactlyOnceWith('game:game-1');
    expect(fixture.presence.clear).toHaveBeenCalledExactlyOnceWith('game-1');
  });

  it('isolates emit, leave, and disconnect errors per socket and always clears target presence', async () => {
    // Break caught: one damaged socket prevents later clients from receiving deletion cleanup.
    const emitFailure = fakeSocket('emit-failure');
    emitFailure.emit.mockImplementation(() => { throw new Error('emit failed'); });
    const leaveFailure = fakeSocket('leave-failure');
    leaveFailure.leave.mockRejectedValue(new Error('leave failed'));
    const disconnectFailure = fakeSocket('disconnect-failure');
    disconnectFailure.disconnect.mockImplementation(() => { throw new Error('disconnect failed'); });
    const finalSocket = fakeSocket('final');
    const fixture = createFixture();
    fixture.service.bindServer(fakeServer(
      new Map([['game:game-1', new Set([
        emitFailure.id,
        leaveFailure.id,
        disconnectFailure.id,
        finalSocket.id
      ])]]),
      new Map([
        [emitFailure.id, emitFailure],
        [leaveFailure.id, leaveFailure],
        [disconnectFailure.id, disconnectFailure],
        [finalSocket.id, finalSocket]
      ])
    ));
    vi.mocked(fixture.socketSessions.revalidate).mockImplementation(async (socket) =>
      socket.id === disconnectFailure.id ? null : authenticatedSession(`user-${socket.id}`)
    );

    await fixture.service.publishDeletedGame('game-1');

    expect(emitFailure.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', {
      gameId: 'game-1',
      reason: 'HARD_DELETED'
    });
    expect(emitFailure.leave).toHaveBeenCalledExactlyOnceWith('game:game-1');
    expect(leaveFailure.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', expect.any(Object));
    expect(leaveFailure.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    expect(finalSocket.emit).toHaveBeenCalledExactlyOnceWith('game.deleted', {
      gameId: 'game-1',
      reason: 'HARD_DELETED'
    });
    expect(finalSocket.leave).toHaveBeenCalledExactlyOnceWith('game:game-1');
    expect(fixture.presence.clear).toHaveBeenCalledExactlyOnceWith('game-1');
  });

  it.each([
    ['no server', undefined],
    ['an empty target room', fakeServer(new Map(), new Map())]
  ] as const)('clears target presence with %s', async (_label, server) => {
    // Break caught: an early return skips stale in-memory cleanup.
    const fixture = createFixture();
    if (server !== undefined) fixture.service.bindServer(server);

    await fixture.service.publishDeletedGame('game-1');

    expect(fixture.presence.clear).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(fixture.socketSessions.revalidate).not.toHaveBeenCalled();
  });
});

describe('GameEventsService.publishGameMessage', () => {
  it('publishes only to revalidated sockets in the target active-game room', async () => {
    // Break caught: a revoked session or unrelated table receives a current-game message.
    const fixture = createFixture();
    const valid = fakeSocket('valid');
    const revoked = fakeSocket('revoked');
    const unrelated = fakeSocket('unrelated', 'game-2');
    fixture.service.bindServer(fakeServer(
      new Map([
        ['game:game-1', new Set([valid.id, revoked.id])],
        ['game:game-2', new Set([unrelated.id])]
      ]),
      new Map([[valid.id, valid], [revoked.id, revoked], [unrelated.id, unrelated]])
    ));
    vi.mocked(fixture.prisma.game.findUnique).mockResolvedValue({
      id: 'game-1',
      status: GameStatus.ACTIVE,
      players: [],
      buyinEvents: []
    } as never);
    vi.mocked(fixture.socketSessions.revalidate).mockImplementation(async (socket) =>
      socket.id === revoked.id ? null : authenticatedSession('valid-user')
    );
    const message: GameMessageDto = {
      id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
      gameId: 'game-1',
      userId: 'valid-user',
      nickname: '西西',
      avatarUrl: '/avatars/preset-13.webp',
      text: '马上到',
      createdAt: '2026-08-24T09:00:00.000Z'
    };

    await fixture.service.publishGameMessage('game-1', message);

    expect(valid.emit).toHaveBeenCalledExactlyOnceWith('game.message.created', message);
    expect(revoked.emit).not.toHaveBeenCalled();
    expect(revoked.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    expect(unrelated.emit).not.toHaveBeenCalled();
  });

  it('does not publish messages after the game leaves the active state', async () => {
    // Break caught: a delayed sender can keep chatting while settlement is already underway.
    const fixture = createFixture();
    const socket = fakeSocket('socket-1');
    fixture.service.bindServer(fakeServer(
      new Map([['game:game-1', new Set([socket.id])]]),
      new Map([[socket.id, socket]])
    ));
    vi.mocked(fixture.prisma.game.findUnique).mockResolvedValue({
      id: 'game-1',
      status: GameStatus.SETTLING,
      players: [],
      buyinEvents: []
    } as never);

    await fixture.service.publishGameMessage('game-1', {
      id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
      gameId: 'game-1',
      userId: 'user-1',
      nickname: '西西',
      avatarUrl: '/avatars/preset-13.webp',
      text: '马上到',
      createdAt: '2026-08-24T09:00:00.000Z'
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(fixture.socketSessions.revalidate).not.toHaveBeenCalled();
  });

  it('rechecks the message lifecycle after an asynchronous socket session revalidation', async () => {
    // Break caught: settlement clears messages while socket revalidation is pending, then a delayed event is still emitted.
    const fixture = createFixture();
    const socket = fakeSocket('socket-1');
    fixture.service.bindServer(fakeServer(
      new Map([['game:game-1', new Set([socket.id])]]),
      new Map([[socket.id, socket]])
    ));
    vi.mocked(fixture.prisma.game.findUnique).mockResolvedValue({
      id: 'game-1',
      status: GameStatus.ACTIVE,
      players: [],
      buyinEvents: []
    } as never);
    let resolveSession!: (session: AuthenticatedSession) => void;
    vi.mocked(fixture.socketSessions.revalidate).mockReturnValue(new Promise((resolve) => {
      resolveSession = resolve;
    }));
    let current = true;
    const message: GameMessageDto = {
      id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
      gameId: 'game-1',
      userId: 'user-1',
      nickname: '西西',
      avatarUrl: '/avatars/preset-13.webp',
      text: '马上到',
      createdAt: '2026-08-24T09:00:00.000Z'
    };

    const publishing = fixture.service.publishGameMessage('game-1', message, () => current);
    await vi.waitFor(() => expect(fixture.socketSessions.revalidate).toHaveBeenCalledOnce());
    current = false;
    resolveSession(authenticatedSession('user-1'));
    await publishing;

    expect(socket.emit).not.toHaveBeenCalled();
  });
});
