import { createPrismaClient, type AppPrismaClient } from "./prisma-client";

const globalForPrisma = globalThis as unknown as {
  prisma?: AppPrismaClient;
};

export function getPrisma() {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}
