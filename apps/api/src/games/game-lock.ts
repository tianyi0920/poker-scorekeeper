import { notFound } from '../common/errors/app-error.js';
import type { Game, Prisma } from '../generated/prisma/client.js';

export async function lockGameForUpdate(
  transaction: Prisma.TransactionClient,
  id: string
): Promise<Game> {
  await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM games WHERE id = ${id} FOR UPDATE
  `;
  const game = await transaction.game.findUnique({ where: { id } });
  if (game === null) throw notFound('NOT_FOUND');
  return game;
}
