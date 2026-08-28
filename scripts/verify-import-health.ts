import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";

function parseSummary(summary: string | null) {
  if (!summary) return null;
  try {
    return JSON.parse(summary) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const prisma = getPrisma();

  const [latestBatches, latestSheetBatch, campaigns] = await Promise.all([
    prisma.importBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        sourceSystem: true,
        status: true,
        createdAt: true,
        summary: true,
      },
    }),
    prisma.importBatch.findFirst({
      where: { sourceSystem: "GOOGLE_SHEETS" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    prisma.salesCampaign.findMany({
      select: {
        id: true,
        startDate: true,
        roundNumber: true,
        salesCode: true,
        sellerId: true,
        dealId: true,
      },
    }),
  ]);

  const duplicateMap = new Map<string, string[]>();
  for (const campaign of campaigns) {
    const key = [
      monthKey(campaign.startDate),
      campaign.sellerId,
      campaign.dealId,
      campaign.roundNumber ?? "na",
    ].join("::");
    const current = duplicateMap.get(key) ?? [];
    current.push(campaign.id);
    duplicateMap.set(key, current);
  }

  const duplicateGroups = Array.from(duplicateMap.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids }));

  let latestSheetBatchDetails: Record<string, unknown> | null = null;
  if (latestSheetBatch) {
    const [records, targets] = await Promise.all([
      prisma.importSourceRecord.groupBy({
        by: ["action"],
        where: { batchId: latestSheetBatch.id },
        _count: { action: true },
      }),
      prisma.importSourceRecord.findMany({
        where: {
          batchId: latestSheetBatch.id,
          action: { in: ["CREATE", "UPDATE"] },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          action: true,
          targetId: true,
          normalizedData: true,
          rawPayload: true,
        },
      }),
    ]);

    latestSheetBatchDetails = {
      batchId: latestSheetBatch.id,
      actionCounts: records.reduce<Record<string, number>>((acc, item) => {
        acc[item.action] = item._count.action;
        return acc;
      }, {}),
      recentTargets: targets.map((item) => {
        const normalized = item.normalizedData ? JSON.parse(item.normalizedData) : {};
        const raw = item.rawPayload ? JSON.parse(item.rawPayload) : {};
        return {
          action: item.action,
          targetId: item.targetId,
          monthKey: normalized.monthKey ?? raw["기간"] ?? null,
          sellerName: normalized.sellerName ?? raw["셀러명"] ?? null,
          brandName: normalized.brandName ?? raw["브랜드"] ?? null,
          productName: normalized.productName ?? raw["상품명"] ?? null,
          roundRaw: normalized.roundRaw ?? raw["회차"] ?? null,
          salesAmount: normalized.salesAmount ?? raw["상품 매출"] ?? null,
        };
      }),
    };
  }

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        latestBatches: latestBatches.map((batch) => ({
          id: batch.id,
          sourceSystem: batch.sourceSystem,
          status: batch.status,
          createdAt: batch.createdAt,
          summary: parseSummary(batch.summary),
        })),
        latestSheetBatch: latestSheetBatchDetails,
        duplicateCampaignGroups: duplicateGroups,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
