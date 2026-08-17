import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

@Injectable()
export class CsrfService {
  private readonly secret: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const configured = config.get<string>('CSRF_SECRET');
    if (!configured && config.get<string>('NODE_ENV') === 'production') {
      throw new Error('CSRF_SECRET is required in production');
    }
    this.secret = configured ?? randomBytes(32).toString('hex');
  }

  createToken(sessionId: string, userId: string): string {
    return createHmac('sha256', this.secret)
      .update(`${sessionId}:${userId}`)
      .digest('hex');
  }

  matches(provided: string | undefined, expected: string): boolean {
    if (provided === undefined || !/^[a-f0-9]{64}$/.test(provided)) return false;
    const providedBytes = Buffer.from(provided, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return providedBytes.length === expectedBytes.length &&
      timingSafeEqual(providedBytes, expectedBytes);
  }
}
