import { getPrisma } from "../src/lib/prisma";

async function main() {
  console.log("Checking history in Postgres...");
  const prisma = getPrisma();

  const sellers = await prisma.seller.findMany({
    include: {
      histories: true
    }
  });

  console.log(`Found ${sellers.length} sellers in Postgres.`);
  for (const s of sellers) {
    console.log(`Seller: ${s.name} (${s.id}) - Handle: ${s.snsHandle}`);
    console.log(`  Histories count: ${s.histories.length}`);
    for (const h of s.histories) {
      console.log(`    - Date: ${h.snapshotDate.toISOString()}, Followers: ${h.followersCount}, Posts: ${h.postsCount}`);
    }
  }
}

main().catch(console.error);
