import { redactAuditValue } from '../../audit/audit-redaction.js';
import { StructuredLogger } from './structured-logger.js';

describe('structured production logger', () => {
  it('emits one JSON record and recursively redacts secrets', () => {
    // Break caught: nested credentials or database URLs are serialized into container logs.
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line), () => '2026-08-18T00:00:00.000Z');

    logger.error({
      event: 'probe',
      requestId: 'safe-request',
      nested: {
        password: 'secret',
        endpoint: 'mysql://user:password@db/poker',
        safe: 'visible'
      }
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: '2026-08-18T00:00:00.000Z',
      level: 'error',
      message: {
        event: 'probe',
        requestId: 'safe-request',
        nested: {
          password: '[REDACTED]',
          endpoint: '[REDACTED]',
          safe: 'visible'
        }
      }
    });
    expect(redactAuditValue(JSON.parse(lines[0]!))).toEqual(JSON.parse(lines[0]!));
  });
});
