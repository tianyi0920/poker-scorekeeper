import type { AuthUser } from '../common/auth/auth-user.js';
import { Role } from '../generated/prisma/client.js';

export function historyScope(actor: AuthUser) {
  return actor.role === Role.USER ? { players: { some: { userId: actor.id } } } : {};
}
