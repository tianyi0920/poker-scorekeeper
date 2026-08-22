import type { Prisma } from '../generated/prisma/client.js';

export async function lockGameLifecycleCoordinator(
  transaction: Prisma.TransactionClient
): Promise<void> {
  await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
  `;
}
