import type { LoggerService } from '@nestjs/common';
import { redactAuditValue } from '../../audit/audit-redaction.js';

export type StructuredLogWriter = (line: string) => void;

const REDACTED = '[REDACTED]';
const SQL_TEXT = /\b(?:select\b[\s\S]{0,2048}\bfrom\b|insert\s+into\b|update\s+[`"\w.]+\s+set\b|delete\s+from\b|(?:create|alter|drop|truncate)\s+(?:table|database|index)\b)/i;

function redactSqlText(value: unknown): unknown {
  if (typeof value === 'string') return SQL_TEXT.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactSqlText);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactSqlText(nested)])
    );
  }
  return value;
}

function sanitizeLogValue(value: unknown): unknown {
  return redactSqlText(redactAuditValue(value));
}

function defaultWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

export class StructuredLogger implements LoggerService {
  constructor(
    private readonly writer: StructuredLogWriter = defaultWriter,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: string, message: unknown, optionalParams: unknown[]): void {
    const record: Record<string, unknown> = {
      timestamp: this.now(),
      level,
      message: sanitizeLogValue(message)
    };
    if (optionalParams.length > 0) record.context = sanitizeLogValue(optionalParams);
    this.writer(JSON.stringify(record));
  }
}
