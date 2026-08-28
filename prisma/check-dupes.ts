import "dotenv/config";
import { createPrismaClient } from "../src/lib/prisma-client";

const prisma = createPrismaClient();

async function main() {
  const deals = await prisma.deal.findMany({
    select: { id: true, dealName: true, partnerId: true, status: true, _count: { select: { campaigns: true } } },
    orderBy: [{ dealName: "asc" }],
  });

  const groups = new Map<string, typeof deals>();
  for (const d of deals) {
    const key = `${d.dealName}|${d.partnerId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  console.log("Duplicate deals:");
  for (const [, items] of groups) {
    if (items.length > 1) {
      for (const d of items) {
        console.log(`  ${d.dealName} | ${d.status} | campaigns: ${d._count.campaigns}`);
      }
      console.log("");
    }
  }
}

main().then(() => prisma.$disconnect());
