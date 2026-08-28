import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Checking sellers and histories...");

  const targetId = "cmph90s2x005gqetkduoz18wx";
  const baseSeller = await prisma.seller.findUnique({
    where: { id: targetId }
  });

  if (!baseSeller) {
    console.log("Base seller not found");
    return;
  }

  const sellers = await prisma.seller.findMany({
    where: {
      snsHandle: baseSeller.snsHandle
    },
    include: {
      histories: true
    }
  });

  console.log(`Found sellers with handle '${baseSeller.snsHandle}': ${sellers.length}`);
  sellers.forEach(s => {
    console.log(`Seller ID: ${s.id}, Name: ${s.name}, Alias: ${s.alias}, Histories Count: ${s.histories.length}`);
    s.histories.forEach(h => {
      console.log(`  - ID: ${h.id}, Date: ${h.snapshotDate.toISOString()}, Followers: ${h.followersCount}, Posts: ${h.postsCount}`);
    });
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
