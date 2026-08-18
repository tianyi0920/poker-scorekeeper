import { Controller, Get, Inject } from '@nestjs/common';
import { serviceUnavailable } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class ReadinessController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      throw serviceUnavailable('DATABASE_UNAVAILABLE');
    }
    return { status: 'ok', database: 'ok' };
  }
}
