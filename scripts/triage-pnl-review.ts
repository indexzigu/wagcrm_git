import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getPrisma } from "../src/lib/prisma";

function getArg(flag: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function productAliases(product: string) {
  const key = normalize(product);
  const aliases = new Set<string>([key]);
  if (key === normalize("고데기")) {
    aliases.add(normalize("무선고데기"));
    aliases.add(normalize("하이소닉S"));
  }
  if (key === normalize("지노프리")) aliases.add(normalize("질 유산균"));
  if (key === normalize("올레샷") || key === normalize("올레올토샷")) {
    aliases.add(normalize("올리브레몬 듀얼샷 45%"));
    aliases.add(normalize("올리브레몬 듀얼샷 40%"));
  }
  if (key === normalize("올리브")) aliases.add(normalize("올리브오일"));
  if (key === normalize("mvpo")) {
    aliases.add(normalize("mvpo 40"));
    aliases.add(normalize("mvpo 43"));
  }
  if (key === normalize("월렛")) aliases.add(normalize("카드지갑"));
  if (key === normalize("set")) {
    aliases.add(normalize("레몬즙"));
    aliases.add(normalize("올리브오일"));
  }
  return Array.from(aliases).filter(Boolean);
}

function parsePeriod(period: string) {
  const match = period.match(/^(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${2000 + Number(match[1])}-${match[2]}`;
}

async function main() {
  const prisma = getPrisma();
  const targetBatchId =
    getArg("--batch-id") ??
    (
      await prisma.importBatch.findFirst({
        where: { sourceSystem: "GOOGLE_SHEETS", mode: "APPLY" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
    )?.id;

  if (!targetBatchId) {
    throw new Error("No APPLY import batch found for GOOGLE_SHEETS");
  }

  const [rows, sellers, deals, campaigns] = await Promise.all([
    prisma.importSourceRecord.findMany({
      where: { batchId: targetBatchId, action: "REVIEW" },
      select: { sourceKey: true, reviewReason: true, rawPayload: true },
    }),
    prisma.seller.findMany({
      select: { id: true, name: true, alias: true },
    }),
    prisma.deal.findMany({
      select: { id: true, dealName: true, brandName: true, partner: { select: { name: true } } },
    }),
    prisma.salesCampaign.findMany({
      select: {
        id: true,
        startDate: true,
        seller: { select: { name: true, alias: true } },
      },
    }),
  ]);

  const result = {
    batchId: targetBatchId,
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      invalidRows: 0,
      ambiguousExisting: 0,
      createCandidate: 0,
      blockedByMissingSeller: 0,
      blockedByMissingDeal: 0,
    },
    invalidRows: [] as Array<Record<string, unknown>>,
    ambiguousExisting: [] as Array<Record<string, unknown>>,
    createCandidates: [] as Array<Record<string, unknown>>,
    blocked: [] as Array<Record<string, unknown>>,
  };

  for (const row of rows) {
    const raw = JSON.parse(row.rawPayload || "{}") as Record<string, string>;
    const period = String(raw["기간"] || "").trim();
    const seller = String(raw["셀러명"] || "").trim();
    const brand = String(raw["브랜드"] || "").trim();
    const product = String(raw["상품명"] || "").trim();
    const round = String(raw["회차"] || "").trim();
    const sales = String(raw["상품 매출"] || "").trim();

    if (!period || !seller || !product) {
      result.summary.invalidRows += 1;
      result.invalidRows.push({
        period,
        seller,
        brand,
        product,
        round,
        sales,
        reason: row.reviewReason,
      });
      continue;
    }

    if ((row.reviewReason || "").includes("ambiguous")) {
      result.summary.ambiguousExisting += 1;
      result.ambiguousExisting.push({
        period,
        seller,
        brand,
        product,
        round,
        sales,
        reason: row.reviewReason,
      });
      continue;
    }

    const sellerKey = normalize(seller);
    const sellerExists = sellers.some((item) => {
      const keys = [item.name, item.alias].filter(Boolean).map((value) => normalize(value));
      return keys.some((value) => value.includes(sellerKey) || sellerKey.includes(value));
    });

    const aliases = productAliases(product);
    const brandKey = normalize(brand);
    const dealExists = deals.some((item) => {
      const dealKey = normalize(item.dealName);
      const partnerOrBrand = normalize(item.brandName || item.partner?.name);
      return (
        aliases.some((value) => value.includes(dealKey) || dealKey.includes(value)) ||
        (brandKey.length > 0 &&
          (partnerOrBrand.includes(brandKey) || brandKey.includes(partnerOrBrand)))
      );
    });

    if (!sellerExists) {
      result.summary.blockedByMissingSeller += 1;
      result.blocked.push({
        type: "missingSeller",
        period,
        seller,
        brand,
        product,
        round,
        sales,
        reason: row.reviewReason,
      });
      continue;
    }

    if (!dealExists) {
      result.summary.blockedByMissingDeal += 1;
      result.blocked.push({
        type: "missingDeal",
        period,
        seller,
        brand,
        product,
        round,
        sales,
        reason: row.reviewReason,
      });
      continue;
    }

    const month = parsePeriod(period);
    const existingMonthCampaignCount = campaigns.filter((campaign) => {
      if (!month) return false;
      const campaignMonth = `${campaign.startDate.getUTCFullYear()}-${String(
        campaign.startDate.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      if (campaignMonth !== month) return false;
      const campaignSeller = normalize(campaign.seller.alias || campaign.seller.name);
      return campaignSeller.includes(sellerKey) || sellerKey.includes(campaignSeller);
    }).length;

    result.summary.createCandidate += 1;
    result.createCandidates.push({
      period,
      seller,
      brand,
      product,
      round,
      sales,
      reason: row.reviewReason,
      existingMonthCampaignCount,
    });
  }

  writeFileSync(
    "artifacts/pnl-review-triage-remote.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );

  console.log(
    JSON.stringify(
      {
        saved: "artifacts/pnl-review-triage-remote.json",
        summary: result.summary,
        sampleCreate: result.createCandidates.slice(0, 10),
        sampleBlocked: result.blocked.slice(0, 10),
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
