import type { GameSnapshotDto } from '@poker/contracts';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { Role } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GameEventsService } from '../realtime/game-events.service.js';
import type { PresenceService } from '../realtime/presence.service.js';
import type { GameMessagesService } from './game-messages.service.js';
import { GamesService } from './games.service.js';

const actor: AuthUser = {
  id: 'admin-1',
  username: 'admin-1',
  nickname: '管理员',
  role: Role.ADMIN,
  mustChangePassword: false,
  avatarKind: 'PRESET',
  avatarValue: 'preset-13'
};

function createFixture(transactionFailure?: Error) {
  const snapshot = { id: 'game-1' } as GameSnapshotDto;
  const prisma = {
    $transaction: vi.fn(async () => {
      if (transactionFailure !== undefined) throw transactionFailure;
      return snapshot;
    })
  } as unknown as PrismaService;
  const events = {
    publishCommittedGame: vi.fn(async () => undefined)
  } as unknown as GameEventsService;
  const gameMessages = {
    clear: vi.fn()
  } as unknown as GameMessagesService;
  const service = Reflect.construct(GamesService, [
    prisma,
    {} as AuditService,
    {} as PresenceService,
    events,
    gameMessages
  ]) as GamesService;
  return { service, events, gameMessages, snapshot };
}

describe('GamesService message lifecycle', () => {
  it.each(['beginSettlement', 'void'] as const)(
    'clears only after committed %s and before publishing the ended game',
    async (method) => {
      // Break caught: ended-game speech survives, or disappears before the lifecycle transaction commits.
      const fixture = createFixture();

      await expect(fixture.service[method]('game-1', actor)).resolves.toBe(fixture.snapshot);

      expect(fixture.gameMessages.clear).toHaveBeenCalledExactlyOnceWith('game-1');
      expect(fixture.events.publishCommittedGame).toHaveBeenCalledExactlyOnceWith('game-1');
      expect(vi.mocked(fixture.gameMessages.clear).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(fixture.events.publishCommittedGame).mock.invocationCallOrder[0]!);
    }
  );

  it.each(['beginSettlement', 'void'] as const)(
    'does not clear or publish when committed %s fails',
    async (method) => {
      // Break caught: a rolled-back end-game attempt erases the still-active table conversation.
      const failure = new Error('commit failed');
      const fixture = createFixture(failure);

      await expect(fixture.service[method]('game-1', actor)).rejects.toBe(failure);

      expect(fixture.gameMessages.clear).not.toHaveBeenCalled();
      expect(fixture.events.publishCommittedGame).not.toHaveBeenCalled();
    }
  );
});
