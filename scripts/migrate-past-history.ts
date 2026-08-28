import "dotenv/config";
import { PrismaClient } from "@prisma/client";

function getKstMidnightUTC(date: Date): Date {
  const kstOffset = 9 * 60 * 60 * 1000; // 9 hours
  const kstTime = new Date(date.getTime() + kstOffset);
  
  return new Date(
    Date.UTC(
      kstTime.getUTCFullYear(),
      kstTime.getUTCMonth(),
      kstTime.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

async function main() {
  console.log("Starting seller past history migration...");
  const prisma = new PrismaClient();

  // Fetch all sellers that have a review date and positive followers
  const sellers = await prisma.seller.findMany({
    where: {
      lastReviewedAt: { not: null },
      currentFollowers: { gt: 0 }
    }
  });

  console.log(`Found ${sellers.length} sellers to migrate.`);
  let migratedCount = 0;

  for (const seller of sellers) {
    if (!seller.lastReviewedAt) continue;

    const snapshotDate = getKstMidnightUTC(seller.lastReviewedAt);

    await prisma.sellersHistory.upsert({
      where: {
        sellerId_snapshotDate: {
          sellerId: seller.id,
          snapshotDate,
        },
      },
      update: {
        source: "IMPORT",
      },
      create: {
        sellerId: seller.id,
        snapshotDate,
        followersCount: seller.currentFollowers,
        source: "IMPORT",
      },
    });

    migratedCount++;
    console.log(`[${migratedCount}/${sellers.length}] Migrated ${seller.name} (${seller.snsHandle}) -> Date: ${snapshotDate.toISOString()}, Followers: ${seller.currentFollowers}`);
  }

  console.log(`Successfully migrated ${migratedCount} seller histories.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
