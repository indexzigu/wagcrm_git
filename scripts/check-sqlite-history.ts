import { PrismaClient as SqlitePrismaClient } from "../prisma/generated/prisma-sqlite";

async function main() {
  console.log("Checking history in local SQLite...");
  // SQLite Prisma Client loaded directly
  const prisma = new SqlitePrismaClient({
    datasources: {
      db: {
        url: "file:./dev.db"
      }
    }
  });

  const sellers = await prisma.seller.findMany({
    include: {
      histories: true
    }
  });

  console.log(`Found ${sellers.length} sellers in SQLite.`);
  for (const s of sellers) {
    console.log(`Seller: ${s.name} (${s.id}) - Handle: ${s.snsHandle}`);
    console.log(`  Histories count: ${s.histories.length}`);
    for (const h of s.histories) {
      console.log(`    - Date: ${h.snapshotDate.toISOString()}, Followers: ${h.followersCount}, Posts: ${h.postsCount}`);
    }
  }
}

main().catch(console.error);
