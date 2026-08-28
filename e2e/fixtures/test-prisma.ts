import { PrismaClient as PostgresPrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const SQLITE_PREFIX = 'file:';
const USE_SQLITE_CLIENT = typeof DATABASE_URL === 'string' && DATABASE_URL.startsWith(SQLITE_PREFIX);

export function getE2ePrismaClient() {
  if (USE_SQLITE_CLIENT) {
    try {
      // E2E Playwright 러너 환경에서는 CommonJS require가 지원됩니다.
       
      const { PrismaClient: SqlitePrismaClient } = require('../../prisma/generated/prisma-sqlite');
      return new SqlitePrismaClient();
    } catch (err) {
      console.error('Failed to load SQLite Prisma client in E2E. Falling back to default Postgres client.', err);
      return new PostgresPrismaClient();
    }
  }
  return new PostgresPrismaClient();
}
