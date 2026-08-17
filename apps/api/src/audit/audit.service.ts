import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { redactAuditValue } from './audit-redaction.js';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId?: string;
  before?: unknown;
  after?: unknown;
  sourceIp?: string;
  userAgent?: string;
}

function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return redactAuditValue(value) as Prisma.InputJsonValue;
}

function safeMetadata(value: string | undefined, fallback: string, maxLength: number): string {
  const sanitized = redactAuditValue(value ?? fallback);
  return (typeof sanitized === 'string' ? sanitized : '[UNREADABLE]').slice(0, maxLength);
}

@Injectable()
export class AuditService {
  async record(transaction: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await transaction.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        requestId: safeMetadata(entry.requestId, randomUUID(), 128),
        beforeJson: nullableJson(entry.before),
        afterJson: nullableJson(entry.after),
        sourceIp: safeMetadata(entry.sourceIp, 'unknown', 45),
        userAgent: safeMetadata(entry.userAgent, 'unknown', 512)
      }
    });
  }
}
