import { Inject, Injectable } from '@nestjs/common';
import type { RakeSettingsDto, UpdateRakeSettingsRequest } from '@poker/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, forbidden } from '../common/errors/app-error.js';
import type { Prisma, SystemSetting } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { lockUsersInOrder, requireCurrentActor } from '../users/user-policy.js';

const SETTINGS_ID = 'singleton';

function toDto(setting: SystemSetting): RakeSettingsDto {
  return {
    threshold: setting.rakeThreshold.toString(),
    bps: setting.rakeBps,
    version: setting.version
  };
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  async getRake(): Promise<RakeSettingsDto> {
    return toDto(await this.prisma.systemSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID } }));
  }

  async updateRake(actor: AuthUser, input: UpdateRakeSettingsRequest): Promise<RakeSettingsDto> {
    const result = await this.prisma.$transaction(async (transaction) => {
      await this.lockSettings(transaction);
      const locked = await lockUsersInOrder(transaction, [actor.id]);
      const currentActor = requireCurrentActor(locked, actor.id);
      if (currentActor.role !== 'SUPER_ADMIN') throw forbidden('FORBIDDEN');

      const before = await transaction.systemSetting.findUniqueOrThrow({
        where: { id: SETTINGS_ID }
      });
      if (before.version !== input.version) throw conflict('SETTINGS_VERSION_CONFLICT');

      const result = await transaction.systemSetting.updateMany({
        where: { id: SETTINGS_ID, version: input.version },
        data: {
          rakeThreshold: BigInt(input.threshold),
          rakeBps: input.bps,
          version: { increment: 1 },
          updatedById: currentActor.id
        }
      });
      if (result.count !== 1) throw conflict('SETTINGS_VERSION_CONFLICT');
      const after = await transaction.systemSetting.findUniqueOrThrow({
        where: { id: SETTINGS_ID }
      });
      const beforeDto = toDto(before);
      const afterDto = toDto(after);
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'RAKE_SETTINGS_UPDATED',
        entityType: 'SYSTEM_SETTING',
        entityId: SETTINGS_ID,
        before: beforeDto,
        after: afterDto
      });
      return afterDto;
    });
    await this.events.publishRakeSettings(result.version).catch(() => undefined);
    return result;
  }

  private async lockSettings(transaction: Prisma.TransactionClient): Promise<void> {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM system_settings WHERE id = ${SETTINGS_ID} FOR UPDATE
    `;
  }
}
