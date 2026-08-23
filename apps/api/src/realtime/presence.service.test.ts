import type { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from './presence.service.js';

describe('PresenceService.clear', () => {
  it('clears every connection for only the requested game', () => {
    // Break caught: deleting one game leaves stale spectators or clears another live table.
    const presence = new PresenceService({} as PrismaService);
    presence.add('game-1', 'user-1', 'socket-1');
    presence.add('game-1', 'user-1', 'socket-2');
    presence.add('game-1', 'user-2', 'socket-3');
    presence.add('game-2', 'user-1', 'socket-4');

    presence.clear('game-1');

    expect(presence.hasConnection('game-1', 'user-1', 'socket-1')).toBe(false);
    expect(presence.hasConnection('game-1', 'user-1', 'socket-2')).toBe(false);
    expect(presence.hasConnection('game-1', 'user-2', 'socket-3')).toBe(false);
    expect(presence.hasConnection('game-2', 'user-1', 'socket-4')).toBe(true);
  });
});
