import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, forbidden } from '../common/errors/app-error.js';
import type { GameStatus } from '../generated/prisma/client.js';

export const ALLOWED_GAME_TRANSITIONS: Readonly<Record<GameStatus, readonly GameStatus[]>> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['SETTLING', 'VOIDED'],
  SETTLING: ['COMPLETED'],
  COMPLETED: [],
  VOIDED: []
};

export function assertGameManager(actor: Pick<AuthUser, 'role'>): void {
  if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') throw forbidden('FORBIDDEN');
}

export function assertCanViewGameSnapshot(
  actor: Pick<AuthUser, 'id' | 'role'>,
  game: { status: GameStatus; players: ReadonlyArray<{ userId: string }> }
): void {
  if (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') return;
  if (game.status === 'ACTIVE' || game.status === 'SETTLING') return;
  if (
    (game.status === 'COMPLETED' || game.status === 'VOIDED') &&
    game.players.some(({ userId }) => userId === actor.id)
  ) return;
  throw forbidden('FORBIDDEN');
}

export function assertGameTransition(from: GameStatus, to: GameStatus): void {
  if (!ALLOWED_GAME_TRANSITIONS[from].includes(to)) throw conflict('GAME_STATE_CONFLICT');
}

export function normalizeGameName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export function defaultShanghaiGameName(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(now);
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const month = number('month');
  const day = number('day');
  const hour = number('hour');
  const session = hour < 12 ? '早场' : hour < 18 ? '午场' : '晚场';
  return `${month}月${day}日${session}`;
}
