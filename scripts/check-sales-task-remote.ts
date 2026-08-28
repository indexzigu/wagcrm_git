import "dotenv/config";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();

  try {
    const tables = await prisma.$queryRawUnsafe<
      Array<{ table_name: string }>
    >(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'SalesTask'",
    );

    const columns = await prisma.$queryRawUnsafe<
      Array<{ column_name: string }>
    >(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'SalesTask' and column_name in ('negotiationMemo', 'testingMemo') order by column_name",
    );

    console.log(JSON.stringify({ tables, columns }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
