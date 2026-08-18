import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { serviceUnavailable } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class ReadinessController {
  private readonly timeoutMilliseconds: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService
  ) {
    const configured = Number(config.get<string>('READINESS_TIMEOUT_MS') ?? '2000');
    this.timeoutMilliseconds = Number.isInteger(configured) && configured >= 10 && configured <= 10_000
      ? configured
      : 2_000;
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRawUnsafe('SELECT 1'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('readiness probe timeout')),
            this.timeoutMilliseconds
          );
          timer.unref();
        })
      ]);
    } catch {
      throw serviceUnavailable('DATABASE_UNAVAILABLE');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return { status: 'ok', database: 'ok' };
  }
}
