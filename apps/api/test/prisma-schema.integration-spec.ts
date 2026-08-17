import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const database = databaseUrl.pathname.slice(1);

if (!database.endsWith('_test')) {
  throw new Error(`Refusing schema integration test on database: ${database}`);
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database,
    connectionLimit: 2
  })
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Prisma financial schema', () => {
  it('creates all financial tables and one settings row', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE()
    `;

    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'users',
        'games',
        'buyin_events',
        'settlements',
        'settlement_results',
        'audit_logs'
      ])
    );

    const settings = await prisma.systemSetting.findUnique({
      where: { id: 'singleton' }
    });
    expect(settings).toMatchObject({
      id: 'singleton',
      rakeThreshold: 1000n,
      rakeBps: 1000,
      version: 1
    });
    expect(await prisma.systemSetting.count()).toBe(1);
  });
});
