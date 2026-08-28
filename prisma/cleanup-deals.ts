import "dotenv/config";
import { createPrismaClient } from "../src/lib/prisma-client";

const prisma = createPrismaClient();

async function main() {
  const deals = await prisma.deal.findMany({
    select: { id: true, dealName: true, partnerId: true, status: true, _count: { select: { campaigns: true } } },
    orderBy: [{ dealName: "asc" }, { status: "asc" }],
  });

  // Group by dealName+partnerId
  const groups = new Map<string, typeof deals>();
  for (const d of deals) {
    const key = `${d.dealName}|${d.partnerId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  let deleted = 0;
  for (const [, items] of groups) {
    if (items.length <= 1) continue;

    // Keep the one with campaigns or ARCHIVED status
    const toDelete = items.filter((d) => d.status === "SOURCING" && d._count.campaigns === 0);
    const toKeep = items.filter((d) => !(d.status === "SOURCING" && d._count.campaigns === 0));

    if (toKeep.length === 0) continue;

    for (const d of toDelete) {
      await prisma.deal.delete({ where: { id: d.id } });
      deleted++;
      console.log(`  DEL: ${d.dealName} (${d.status}, 0 campaigns)`);
    }
  }

  console.log(`\nDeleted: ${deleted} duplicate deals`);
  console.log(`Remaining deals: ${await prisma.deal.count()}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
