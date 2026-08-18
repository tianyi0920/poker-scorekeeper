import type { LoggerService } from '@nestjs/common';
import { redactAuditValue } from '../../audit/audit-redaction.js';

export type StructuredLogWriter = (line: string) => void;

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
      message: redactAuditValue(message)
    };
    if (optionalParams.length > 0) record.context = redactAuditValue(optionalParams);
    this.writer(JSON.stringify(record));
  }
}
