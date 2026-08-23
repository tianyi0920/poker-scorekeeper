import type { AuthenticatedSession } from '../common/auth/auth-user.js';
import { Role } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PresenceService } from './presence.service.js';
import { GameEventsService } from './game-events.service.js';
import type { SocketSessionAdapter } from './socket-session.adapter.js';
import type { Server } from 'socket.io';

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
