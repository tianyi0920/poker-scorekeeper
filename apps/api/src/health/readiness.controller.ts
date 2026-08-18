import { Controller, Get, Inject } from '@nestjs/common';
import { serviceUnavailable } from '../common/errors/app-error.js';
import { MariaDbReadinessProbe } from './mariadb-readiness.probe.js';

export interface ReadinessProbe {
  check(): Promise<void>;
}

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(MariaDbReadinessProbe) private readonly probe: ReadinessProbe
  ) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.probe.check();
    } catch {
      throw serviceUnavailable('DATABASE_UNAVAILABLE');
    }
    return { status: 'ok', database: 'ok' };
  }
}
