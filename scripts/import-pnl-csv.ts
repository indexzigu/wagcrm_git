import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import Papa from "papaparse";
import { getPrisma } from "../src/lib/prisma";
import {
  hashPayload,
  normalizeKey,
  parseCurrency,
  parsePercent,
  toNullableString,
} from "../src/lib/notion-import/normalize";

type TargetMode = "local" | "remote";
type CsvRow = Record<string, string>;
type ImportAction = "create" | "update" | "review";

const CSV_PATH = "/Users/z9/Downloads/YG 비용 - 손익계산.csv";

function parseCsv(path: string) {
  const text = readFileSync(path, "utf8");
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.filter((row) => {
    if (!Object.values(row).some((value) => String(value ?? "").trim().length > 0)) {
      return false;
    }

    const period = toNullableString(row["기간"]);
    const monthKey = parsePeriodMonth(period);
    const hasCoreFields = ["셀러명", "브랜드", "상품명", "회차", "상품 매출"].some((key) =>
      Boolean(toNullableString(row[key])),
    );

    if (!hasCoreFields) {
      if (!monthKey) return false;
      if (monthKey >= "2026-06") return false;
    }

    return true;
  });
}

function getArg(flag: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

function isApplyMode() {
  return process.argv.includes("--apply");
}

function canCreateMissingCampaigns() {
  return process.argv.includes("--create-missing-campaigns");
}

function toDateTime(value: string | null) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function parsePeriodMonth(period: string | null) {
  if (!period) return null;
  const [yyRaw, mmRaw] = period.split("-");
  const yy = Number(yyRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || mm < 1 || mm > 12) return null;
  return `${2000 + yy}-${String(mm).padStart(2, "0")}`;
}

function parseBooleanFlag(value: unknown) {
  const normalized = normalizeKey(value);
  if (!normalized) return null;
  if (["true", "1", "y", "yes", "t"].includes(normalized)) return true;
  if (["false", "0", "n", "no", "f"].includes(normalized)) return false;
  return null;
}

function parseRoundNumber(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const match = normalized.match(/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapSalesChannel(value: unknown) {
  const normalized = normalizeKey(value);
  if (normalized.includes("셀러몰")) return "SELLER_MALL";
  if (normalized.includes("자사몰n")) return "OWN_MALL_NAVER";
  if (normalized.includes("자사몰k")) return "OWN_MALL_KAKAO";
  if (normalized.includes("브랜드몰")) return "BRAND_MALL";
  return null;
}

function mapCommissionBasis(value: unknown) {
  const normalized = normalizeKey(value);
  if (normalized === "sp") return "SP";
  if (normalized === "cp") return "CP";
  return null;
}

function mapSellerTaxType(value: unknown) {
  const normalized = normalizeKey(value);
  if (normalized === "i") return "INDIVIDUAL";
  if (normalized === "b") return "BUSINESS";
  return null;
}

function buildProductAliases(product: string | null) {
  const key = normalizeKey(product);
  const aliases = new Set<string>([key]);
  if (key === normalizeKey("고데기")) {
    aliases.add(normalizeKey("무선고데기"));
    aliases.add(normalizeKey("하이소닉S"));
  }
  if (key === normalizeKey("지노프리")) aliases.add(normalizeKey("질 유산균"));
  if (key === normalizeKey("올레샷") || key === normalizeKey("올레올토샷")) {
    aliases.add(normalizeKey("올리브레몬 듀얼샷 45%"));
    aliases.add(normalizeKey("올리브레몬 듀얼샷 40%"));
  }
  if (key === normalizeKey("올리브")) aliases.add(normalizeKey("올리브오일"));
  if (key === normalizeKey("mvpo")) {
    aliases.add(normalizeKey("MVPO 40"));
    aliases.add(normalizeKey("MVPO 43"));
  }
  if (key === normalizeKey("월렛")) aliases.add(normalizeKey("카드지갑"));
  return Array.from(aliases).filter(Boolean);
}

function buildBrandAliases(brand: string | null) {
  const key = normalizeKey(brand);
  const aliases = new Set<string>([key]);
  if (key === normalizeKey("뷰드")) aliases.add(normalizeKey("델뷰"));
  return Array.from(aliases).filter(Boolean);
}

function buildCampaignIdentityKey(input: {
  monthKey: string | null;
  sellerKey: string | null;
  dealId: string | null;
  brandKey?: string | null;
  productKey?: string | null;
  roundNumber: number | null;
}) {
  return [
    input.monthKey ?? "unknown-month",
    input.sellerKey ?? "unknown-seller",
    input.dealId ?? [input.brandKey ?? "unknown-brand", input.productKey ?? "unknown-product"].join("::"),
    input.roundNumber ?? "unknown-round",
  ].join("::");
}

function parseDealVariantNumber(value: string | null | undefined) {
  const raw = toNullableString(value);
  if (!raw) return null;
  const matches = Array.from(raw.matchAll(/(\d+)/g)).map((match) => Number(match[1]));
  const finite = matches.filter((num) => Number.isFinite(num));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

function selectDealCandidate(
  deals: Array<{
    id: string;
    dealName: string;
    brandName: string | null;
    partner: { name: string } | null;
  }>,
  aliases: string[],
  brandAliases: string[],
  productName: string | null,
) {
  const productCandidates = deals.filter((deal) => {
    const dealKey = normalizeKey(deal.dealName);
    return aliases.some((alias) => alias.includes(dealKey) || dealKey.includes(alias));
  });
  if (productCandidates.length === 0) return null;
  if (productCandidates.length === 1) return productCandidates[0].id;

  const brandMatched = productCandidates.filter((deal) => {
    const campaignBrand = normalizeKey(deal.brandName ?? deal.partner?.name);
    return (
      brandAliases.length > 0 &&
      brandAliases.some(
        (brandAlias) =>
          campaignBrand.includes(brandAlias) || brandAlias.includes(campaignBrand),
      )
    );
  });
  if (brandMatched.length === 1) return brandMatched[0].id;

  const mvpoKey = normalizeKey(productName);
  const pool = brandMatched.length > 0 ? brandMatched : productCandidates;
  if (mvpoKey === normalizeKey("mvpo")) {
    const withVersion = pool
      .map((deal) => ({ deal, version: parseDealVariantNumber(deal.dealName) ?? -1 }))
      .sort((a, b) => b.version - a.version);
    if (withVersion.length > 0 && withVersion[0].version >= 0) {
      return withVersion[0].deal.id;
    }
  }

  return null;
}

function findDealCandidateBuckets(
  deals: Array<{
    id: string;
    dealName: string;
    brandName: string | null;
    partner: { name: string } | null;
  }>,
  aliases: string[],
  brandAliases: string[],
) {
  const productCandidates = deals.filter((deal) => {
    const dealKey = normalizeKey(deal.dealName);
    return aliases.some((alias) => alias.includes(dealKey) || dealKey.includes(alias));
  });

  const brandMatched = productCandidates.filter((deal) => {
    const campaignBrand = normalizeKey(deal.brandName ?? deal.partner?.name);
    return (
      brandAliases.length > 0 &&
      brandAliases.some(
        (brandAlias) =>
          campaignBrand.includes(brandAlias) || brandAlias.includes(campaignBrand),
      )
    );
  });

  return { productCandidates, brandMatched };
}

async function ensurePartnerMaster(
  prisma: ReturnType<typeof getPrisma>,
  partners: Array<{ id: string; name: string; type: string }>,
  brandName: string,
) {
  const brandKey = normalizeKey(brandName);
  const existing =
    partners.find((partner) => normalizeKey(partner.name) === brandKey) ??
    partners.find((partner) => {
      const partnerKey = normalizeKey(partner.name);
      return partnerKey.includes(brandKey) || brandKey.includes(partnerKey);
    });

  if (existing) return existing;

  const created = await prisma.partner.create({
    data: {
      name: brandName,
      type: "BRAND",
    },
    select: { id: true, name: true, type: true },
  });
  partners.push(created);
  return created;
}

async function ensureDealMasterForRow(
  prisma: ReturnType<typeof getPrisma>,
  partners: Array<{ id: string; name: string; type: string }>,
  deals: Array<{
    id: string;
    dealName: string;
    brandName: string | null;
    partner: { name: string } | null;
  }>,
  row: {
    brandName: string | null;
    productName: string | null;
  },
) {
  if (!row.brandName || !row.productName) return null;

  const productKey = normalizeKey(row.productName);
  const brandKey = normalizeKey(row.brandName);
  const forceDedicatedDeal =
    brandKey === normalizeKey("비비랩") &&
    productKey === normalizeKey("올레올토샷");

  if (forceDedicatedDeal) {
    const exactExisting = deals.find(
      (deal) =>
        normalizeKey(deal.dealName) === productKey &&
        normalizeKey(deal.brandName ?? deal.partner?.name) === brandKey,
    );
    if (exactExisting) return exactExisting.id;
  }

  const brandAliases = buildBrandAliases(row.brandName);
  const aliases = buildProductAliases(row.productName);
  const { productCandidates, brandMatched } = findDealCandidateBuckets(
    deals,
    aliases,
    brandAliases,
  );
  const selected = forceDedicatedDeal
    ? null
    : selectDealCandidate(deals, aliases, brandAliases, row.productName);
  if (selected) return selected;

  // Existing product variants for the same brand should stay in review rather than
  // inventing a third variant from PnL alone.
  if (!forceDedicatedDeal && brandMatched.length > 0) return null;

  const partner = await ensurePartnerMaster(prisma, partners, row.brandName);
  const created = await prisma.deal.create({
    data: {
      dealName: row.productName,
      brandName: row.brandName,
      partnerId: partner.id,
      status: "ARCHIVED",
      baseMarginPolicy: JSON.stringify({
        byChannel: {
          BRAND_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
          OWN_MALL_NAVER: { totalMarginRate: 0, sellerMarginRate: 0 },
          OWN_MALL_KAKAO: { totalMarginRate: 0, sellerMarginRate: 0 },
          SELLER_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
        },
      }),
    },
    select: {
      id: true,
      dealName: true,
      brandName: true,
      partner: { select: { name: true } },
    },
  });
  deals.push(created);
  return created.id;
}

function cleanReviewReason(reason: Array<string | null | undefined>) {
  const compact = Array.from(new Set(reason.filter(Boolean) as string[]));
  return compact.length > 0 ? compact.join(",") : null;
}

function toMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function compareSalesCodeRound(salesCode: string | null, roundRaw: string | null) {
  const round = parseRoundNumber(roundRaw);
  if (round == null) return false;
  return normalizeKey(salesCode).includes(`${round}차`);
}

function periodToDateRange(periodMonth: string | null) {
  if (!periodMonth) return null;
  const [yearRaw, monthRaw] = periodMonth.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  const start = new Date(Date.UTC(year, month - 1, 15));
  const end = new Date(Date.UTC(year, month - 1, 18));
  return { start, end };
}

// P&L 마스터 셀러는 실명이라 코드에 하드코딩하지 않고 gitignore 된 로컬 설정에서 읽는다
// (PUBLIC 레포 미노출 — AGENTS.md P0). 템플릿: scripts/config/pnl-master-sellers.example.json
type PnlMasterSeller = { name: string; alias: string; snsHandle: string };

function loadPnlMasterSellers(): PnlMasterSeller[] {
  const path = join(process.cwd(), "scripts/config/pnl-master-sellers.local.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `P&L 마스터 셀러 설정이 없습니다: ${path}\n` +
        `scripts/config/pnl-master-sellers.example.json 을 복사해 실제 셀러로 채우세요.`,
    );
  }
  const parsed = JSON.parse(raw) as { sellers?: PnlMasterSeller[] };
  if (!parsed.sellers?.length) {
    throw new Error(`P&L 마스터 셀러 설정에 sellers 배열이 비어 있습니다: ${path}`);
  }
  return parsed.sellers;
}

async function ensurePnLMasterData(prisma: ReturnType<typeof getPrisma>) {
  for (const seller of loadPnlMasterSellers()) {
    const existing = await prisma.seller.findFirst({
      where: { name: seller.name },
      select: { id: true },
    });
    if (!existing) {
      await prisma.seller.create({
        data: {
          name: seller.name,
          alias: seller.alias,
          snsType: "INSTAGRAM",
          snsHandle: seller.snsHandle,
          currentFollowers: 0,
        },
      });
    }
  }

  const bobaPartner =
    (await prisma.partner.findFirst({
      where: { name: "보바" },
      select: { id: true },
    })) ??
    (await prisma.partner.create({
      data: {
        name: "보바",
        type: "BRAND",
      },
      select: { id: true },
    }));

  const batteryDeal = await prisma.deal.findFirst({
    where: { dealName: { contains: "보조배터리" } },
    select: { id: true },
  });

  if (!batteryDeal) {
    await prisma.deal.create({
      data: {
        dealName: "보조배터리",
        partnerId: bobaPartner.id,
        status: "ARCHIVED",
        baseMarginPolicy: JSON.stringify({
          byChannel: {
            BRAND_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
            OWN_MALL_NAVER: { totalMarginRate: 0, sellerMarginRate: 0 },
            OWN_MALL_KAKAO: { totalMarginRate: 0, sellerMarginRate: 0 },
            SELLER_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
          },
        }),
      },
    });
  }
}

async function createImportRecord(
  prisma: ReturnType<typeof getPrisma>,
  batchId: string,
  sourceTable: string,
  input: {
    sourceKey: string;
    rowHash: string;
    action: ImportAction;
    reviewReason: string | null;
  },
  rawPayload: unknown,
  normalizedData: unknown,
  targetEntity?: string,
  targetId?: string,
) {
  const payload = {
    batchId,
    sourceTable,
    sourceKey: input.sourceKey,
    rowHash: input.rowHash,
    action: input.action.toUpperCase(),
    targetEntity,
    targetId,
    reviewReason: input.reviewReason,
    rawPayload: JSON.stringify(rawPayload),
    normalizedData: JSON.stringify(normalizedData),
  };

  await prisma.importSourceRecord.upsert({
    where: {
      batchId_sourceTable_sourceKey: {
        batchId,
        sourceTable,
        sourceKey: input.sourceKey,
      },
    },
    create: payload,
    update: payload,
  });
}

async function main() {
  const target = (getArg("--target") ?? "local") as TargetMode;
  if (target === "local") {
    process.env.DATABASE_URL = "file:./dev.db";
    process.env.DIRECT_URL = "";
  }

  const rows = parseCsv(CSV_PATH);
  const prisma = getPrisma();
  if (isApplyMode()) {
    await ensurePnLMasterData(prisma);
  }

  const [campaigns, sellers, deals, partners] = await Promise.all([
    prisma.salesCampaign.findMany({
      select: {
        id: true,
        salesCode: true,
        startDate: true,
        actualSales: true,
        roundNumber: true,
        deal: {
          select: {
            id: true,
            dealName: true,
            brandName: true,
            partner: { select: { name: true } },
          },
        },
        seller: {
          select: {
            id: true,
            name: true,
            alias: true,
          },
        },
      },
    }),
    prisma.seller.findMany({
      select: { id: true, name: true, alias: true },
    }),
    prisma.deal.findMany({
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partner: { select: { name: true } },
      },
    }),
    prisma.partner.findMany({
      select: { id: true, name: true, type: true },
    }),
  ]);

  const campaignIdentityIndex = new Map<string, (typeof campaigns)[number]>();
  for (const campaign of campaigns) {
    campaignIdentityIndex.set(
      buildCampaignIdentityKey({
        monthKey: toMonthKey(campaign.startDate),
        sellerKey: campaign.seller.id,
        dealId: campaign.deal.id,
        roundNumber: campaign.roundNumber ?? parseRoundNumber(campaign.salesCode),
      }),
      campaign,
    );
  }

  const analysis = rows.map((row) => {
    const period = toNullableString(row["기간"]);
    const monthKey = parsePeriodMonth(period);
    const sellerName = toNullableString(row["셀러명"]);
    const brandName = toNullableString(row["브랜드"]);
    const productName = toNullableString(row["상품명"]);
    const roundRaw = toNullableString(row["회차"]);
    const salesAmount = parseCurrency(row["상품 매출"]);
    const aliases = buildProductAliases(productName);
    const brandAliases = buildBrandAliases(brandName);
    const sellerKey = normalizeKey(sellerName);
    const brandKey = normalizeKey(brandName);

    const sellerCandidates = sellers.filter((seller) => {
      const candidateKey = normalizeKey(seller.alias ?? seller.name);
      return candidateKey.includes(sellerKey) || sellerKey.includes(candidateKey);
    });

    const dealCandidates = deals.filter((deal) => {
      const dealKey = normalizeKey(deal.dealName);
      const productMatches = aliases.some((alias) => alias.includes(dealKey) || dealKey.includes(alias));
      const campaignBrand = normalizeKey(deal.brandName ?? deal.partner?.name);
      const brandMatches =
        brandAliases.length > 0 &&
        brandAliases.some(
          (brandAlias) =>
            campaignBrand.includes(brandAlias) || brandAlias.includes(campaignBrand),
        );
      return productMatches || brandMatches;
    });
    const selectedDealCandidateId = selectDealCandidate(
      deals,
      aliases,
      brandAliases,
      productName,
    );
    const exactIdentityMatch =
      monthKey &&
      sellerCandidates.length === 1 &&
      selectedDealCandidateId
        ? campaignIdentityIndex.get(
            buildCampaignIdentityKey({
              monthKey,
              sellerKey: sellerCandidates[0].id,
              dealId: selectedDealCandidateId,
              brandKey,
              productKey: normalizeKey(productName),
              roundNumber: parseRoundNumber(roundRaw),
            }),
          ) ?? null
        : null;

    const candidates = campaigns.filter((campaign) => {
      if (!monthKey || toMonthKey(campaign.startDate) !== monthKey) return false;
      const campaignSeller = normalizeKey(campaign.seller.alias ?? campaign.seller.name);
      const sellerMatches =
        sellerKey.length > 0 &&
        (campaignSeller.includes(sellerKey) || sellerKey.includes(campaignSeller));
      if (!sellerMatches) return false;

      const campaignBrand = normalizeKey(campaign.deal.brandName ?? campaign.deal.partner?.name);
      const brandMatches =
        brandAliases.length > 0 &&
        brandAliases.some(
          (brandAlias) =>
            campaignBrand.includes(brandAlias) || brandAlias.includes(campaignBrand),
        );

      const dealKey = normalizeKey(campaign.deal.dealName);
      const productMatches = aliases.some((alias) => alias.includes(dealKey) || dealKey.includes(alias));
      const roundMatches = compareSalesCodeRound(campaign.salesCode, roundRaw);
      return productMatches || brandMatches || roundMatches;
    });

    const exactBySales =
      salesAmount == null
        ? []
        : candidates.filter(
            (campaign) => Number(campaign.actualSales ?? 0) === Number(salesAmount),
          );
    const roundMatched = candidates.filter((campaign) =>
      compareSalesCodeRound(campaign.salesCode, roundRaw),
    );
    const productMatched = candidates.filter((campaign) => {
      const dealKey = normalizeKey(campaign.deal.dealName);
      return aliases.some((alias) => alias.includes(dealKey) || dealKey.includes(alias));
    });
    const resolved =
      exactIdentityMatch ??
      (exactBySales.length === 1
        ? exactBySales[0]
        : roundMatched.length === 1
          ? roundMatched[0]
          : productMatched.length === 1
            ? productMatched[0]
            : candidates.length === 1
              ? candidates[0]
              : null);

    const reviewReason = cleanReviewReason([
      !monthKey ? "invalid-period" : null,
      !sellerName ? "missing-seller-name" : null,
      !productName ? "missing-product-name" : null,
      !salesAmount && salesAmount !== 0 ? "missing-sales-amount" : null,
      candidates.length === 0 ? "missing-campaign-match" : null,
      candidates.length > 1 && exactBySales.length === 0 ? "ambiguous-campaign-match" : null,
      exactBySales.length > 1 ? "ambiguous-sales-match" : null,
    ]);

    const sourceKey = [
      monthKey ?? period ?? "unknown-period",
      normalizeKey(sellerName),
      normalizeKey(brandName),
      normalizeKey(productName),
      normalizeKey(roundRaw),
    ].join("::");

    const normalized = {
      monthKey,
      sellerName,
      brandName,
      productName,
      roundRaw,
      salesAmount,
      sellerCandidateId:
        sellerCandidates.length === 1 ? sellerCandidates[0].id : null,
      dealCandidateId:
        selectedDealCandidateId,
      totalMarginRate: parsePercent(row["총 수수료"]),
      settlementSales: parseCurrency(row["전체 수수료 매출"]),
      isDepositReceived: parseBooleanFlag(row["입금"]),
      sellerMarginRate: parsePercent(row["셀러 수수료율"]),
      sellerExpense: parseCurrency(row["셀러 수수료"]),
      actualPayoutAmount: parseCurrency(row["용역 수수료"]),
      isPayoutCompleted: parseBooleanFlag(row["지급"]),
      netMarginRate: parsePercent(row["순 수수료"]),
      operatingExpense: parseCurrency(row["운영비"]),
      taxExpense: parseCurrency(row["과세"]),
      miscExpense: parseCurrency(row["기타"]),
      operatingProfit: parseCurrency(row["NET매출"]),
      quantity: parseCurrency(row["수량"]),
      salesChannel: mapSalesChannel(row["채널"]),
      commissionBasis: mapCommissionBasis(row["가격"]),
      sellerTaxType: mapSellerTaxType(row["유형"]),
      roundNumber: parseRoundNumber(row["회차"]),
      notesFromImport: toNullableString(row["비고"]),
      reviewReason,
      hasOnlyMissingCampaign:
        !cleanReviewReason([
          !monthKey ? "invalid-period" : null,
          !sellerName ? "missing-seller-name" : null,
          !productName ? "missing-product-name" : null,
        ]) &&
        cleanReviewReason([
          sellerCandidates.length === 0 ? "missing-seller-master" : null,
          sellerCandidates.length > 1 ? "ambiguous-seller-master" : null,
          !selectedDealCandidateId && dealCandidates.length === 0 ? "missing-deal-master" : null,
          !selectedDealCandidateId && dealCandidates.length > 1 ? "ambiguous-deal-master" : null,
        ]) === null &&
        Boolean(
          reviewReason &&
            reviewReason
              .split(",")
              .every((reason) => ["missing-campaign-match", "ambiguous-campaign-match", "ambiguous-sales-match"].includes(reason)),
        ),
    };

    return {
      row,
      sourceKey,
      rowHash: hashPayload(row),
      candidates,
      resolved,
      reviewReason,
      normalized,
    };
  });

  const summary = {
    mode: isApplyMode() ? "apply" : "dry-run",
    target,
    generatedAt: new Date().toISOString(),
    csvRows: rows.length,
    dbCampaigns: campaigns.length,
    counts: {
      matched: analysis.filter((item) => item.resolved && !item.reviewReason).length,
      review: analysis.filter((item) => !item.resolved || item.reviewReason).length,
      missingCampaign: analysis.filter((item) => item.reviewReason?.includes("missing-campaign-match")).length,
      ambiguous: analysis.filter((item) =>
        item.reviewReason?.includes("ambiguous-campaign-match") ||
        item.reviewReason?.includes("ambiguous-sales-match"),
      ).length,
    },
    reviewSamples: analysis
      .filter((item) => !item.resolved || item.reviewReason)
      .slice(0, 20)
      .map((item) => ({
        sourceKey: item.sourceKey,
        reviewReason: item.reviewReason,
        candidateIds: item.candidates.map((candidate) => candidate.id),
        seller: item.normalized.sellerName,
        brand: item.normalized.brandName,
        product: item.normalized.productName,
        month: item.normalized.monthKey,
      })),
  };

  const artifactDir = join(process.cwd(), "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(
    artifactDir,
    `pnl-import-${isApplyMode() ? "apply" : "dry-run"}-${target}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (!isApplyMode()) {
    console.log(JSON.stringify({ artifactPath, ...summary }, null, 2));
    await prisma.$disconnect();
    return;
  }

  const batch = await prisma.importBatch.create({
    data: {
      sourceSystem: "GOOGLE_SHEETS",
      targetDatabase: target.toUpperCase(),
      mode: "APPLY",
      status: "RUNNING",
      summary: "손익계산 CSV import apply",
    },
  });

  let createCount = 0;
  let updateCount = 0;
  let reviewCount = 0;

  for (const item of analysis) {
    let resolvedDealCandidateId = item.normalized.dealCandidateId;
    if (!resolvedDealCandidateId && canCreateMissingCampaigns()) {
      resolvedDealCandidateId = await ensureDealMasterForRow(
        prisma,
        partners,
        deals,
        {
          brandName: item.normalized.brandName,
          productName: item.normalized.productName,
        },
      );
      item.normalized.dealCandidateId = resolvedDealCandidateId;
    }

    const creationBlockingReason = cleanReviewReason([
      !item.normalized.monthKey ? "invalid-period" : null,
      !item.normalized.sellerName ? "missing-seller-name" : null,
      !item.normalized.productName ? "missing-product-name" : null,
      !item.normalized.sellerCandidateId ? "missing-seller-master" : null,
      !resolvedDealCandidateId ? "missing-deal-master" : null,
    ]);
    const reviewReasonAllowsCreate = Boolean(
      item.reviewReason &&
        item.reviewReason
          .split(",")
          .every((reason) =>
            [
              "missing-campaign-match",
              "ambiguous-campaign-match",
              "ambiguous-sales-match",
              "missing-sales-amount",
            ].includes(reason),
          ),
    );

    const canCreateFromMissingCampaign =
      canCreateMissingCampaigns() &&
      !item.resolved &&
      !creationBlockingReason &&
      reviewReasonAllowsCreate;

    if (!item.resolved && !canCreateFromMissingCampaign) {
      reviewCount += 1;
      await createImportRecord(
        prisma,
        batch.id,
        "pnl_csv",
        {
          sourceKey: item.sourceKey,
          rowHash: item.rowHash,
          action: "review",
          reviewReason: item.reviewReason ?? "unknown-review-reason",
        },
        item.row,
        item.normalized,
      );
      continue;
    }

    if (item.reviewReason && !item.resolved && !canCreateFromMissingCampaign) {
      reviewCount += 1;
      await createImportRecord(
        prisma,
        batch.id,
        "pnl_csv",
        {
          sourceKey: item.sourceKey,
          rowHash: item.rowHash,
          action: "review",
          reviewReason: item.reviewReason,
        },
        item.row,
        item.normalized,
      );
      continue;
    }

    let campaignId = item.resolved?.id ?? null;
    let campaignDealId = item.resolved?.deal.id ?? null;
    let isCreate = false;

    if (!campaignId && canCreateFromMissingCampaign) {
      const dateRange = periodToDateRange(item.normalized.monthKey);
      if (!dateRange) {
        reviewCount += 1;
        await createImportRecord(
          prisma,
          batch.id,
          "pnl_csv",
          {
            sourceKey: item.sourceKey,
            rowHash: item.rowHash,
            action: "review",
            reviewReason: "invalid-period-for-create",
          },
          item.row,
          item.normalized,
        );
        continue;
      }

      if (!resolvedDealCandidateId || !item.normalized.sellerCandidateId) {
        // creationBlockingReason 계산상 이 분기는 항상 두 값이 있어야 도달하지만,
        // 타입만이 아니라 실제로도 거래처·셀러 마스터 없이는 캠페인을 만들 수 없다
        // — 방어적으로 review 처리한다.
        reviewCount += 1;
        await createImportRecord(
          prisma,
          batch.id,
          "pnl_csv",
          {
            sourceKey: item.sourceKey,
            rowHash: item.rowHash,
            action: "review",
            reviewReason: "campaign-resolution-failed",
          },
          item.row,
          item.normalized,
        );
        continue;
      }

      const dealCandidateId = resolvedDealCandidateId;
      const sellerCandidateId = item.normalized.sellerCandidateId;

      const created = await prisma.salesCampaign.create({
        data: {
          dealId: dealCandidateId,
          sellerId: sellerCandidateId,
          salesCode: [item.normalized.productName, item.normalized.sellerName, item.normalized.roundRaw]
            .filter(Boolean)
            .join(" "),
          startDate: dateRange.start,
          endDate: dateRange.end,
          salesChannel: item.normalized.salesChannel ?? "BRAND_MALL",
          baseNaverLink: "",
          generatedTrackingLink: "",
          status: item.normalized.salesAmount == null ? "PROPOSAL" : "COMPLETED",
        },
        select: { id: true, dealId: true },
      });
      campaignId = created.id;
      campaignDealId = created.dealId;
      isCreate = true;
      campaignIdentityIndex.set(
        buildCampaignIdentityKey({
          monthKey: item.normalized.monthKey,
          sellerKey: sellerCandidateId,
          dealId: created.dealId,
          brandKey: normalizeKey(item.normalized.brandName),
          productKey: normalizeKey(item.normalized.productName),
          roundNumber: item.normalized.roundNumber,
        }),
        {
          id: created.id,
          salesCode: [item.normalized.productName, item.normalized.sellerName, item.normalized.roundRaw]
            .filter(Boolean)
            .join(" "),
          startDate: dateRange.start,
          actualSales:
            item.normalized.salesAmount != null ? new Prisma.Decimal(item.normalized.salesAmount) : null,
          roundNumber: item.normalized.roundNumber,
          deal: {
            id: created.dealId,
            dealName: item.normalized.productName ?? "",
            brandName: item.normalized.brandName,
            partner: { name: item.normalized.brandName ?? "" },
          },
          seller: {
            id: sellerCandidateId,
            name: item.normalized.sellerName ?? "",
            alias: item.normalized.sellerName,
          },
        },
      );
    }

    if (!campaignId || !campaignDealId) {
      reviewCount += 1;
      await createImportRecord(
        prisma,
        batch.id,
        "pnl_csv",
        {
          sourceKey: item.sourceKey,
          rowHash: item.rowHash,
          action: "review",
          reviewReason: "campaign-resolution-failed",
        },
        item.row,
        item.normalized,
      );
      continue;
    }

    const existingNotes = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { notesFromImport: true },
    });
    const mergedNotes = [toNullableString(existingNotes?.notesFromImport), item.normalized.notesFromImport]
      .filter(Boolean)
      .join("\n")
      .trim();

    const hasSalesAmount = item.normalized.salesAmount != null;
    const totalMarginRate = item.normalized.totalMarginRate ?? 0;
    const sellerMarginRate = item.normalized.sellerMarginRate ?? 0;
    const payload = {
      actualSales: hasSalesAmount ? item.normalized.salesAmount : undefined,
      totalMarginRate,
      settlementSales: hasSalesAmount ? item.normalized.settlementSales : undefined,
      isDepositReceived:
        hasSalesAmount && item.normalized.isDepositReceived !== null
          ? item.normalized.isDepositReceived
          : undefined,
      sellerMarginRate,
      sellerExpense: hasSalesAmount ? item.normalized.sellerExpense : undefined,
      actualPayoutAmount: hasSalesAmount ? item.normalized.actualPayoutAmount : undefined,
      isPayoutCompleted:
        hasSalesAmount && item.normalized.isPayoutCompleted !== null
          ? item.normalized.isPayoutCompleted
          : undefined,
      netMarginRate: item.normalized.netMarginRate ?? Math.max(0, totalMarginRate - sellerMarginRate),
      operatingExpense: hasSalesAmount ? item.normalized.operatingExpense : undefined,
      taxExpense: hasSalesAmount ? item.normalized.taxExpense : undefined,
      miscExpense: hasSalesAmount ? item.normalized.miscExpense : undefined,
      operatingProfit: hasSalesAmount ? item.normalized.operatingProfit : undefined,
      quantity: item.normalized.quantity,
      salesChannel: item.normalized.salesChannel ?? undefined,
      commissionBasis: item.normalized.commissionBasis ?? undefined,
      sellerTaxType: item.normalized.sellerTaxType ?? undefined,
      roundNumber: item.normalized.roundNumber,
      notesFromImport: mergedNotes || null,
      status: hasSalesAmount ? "COMPLETED" : "PROPOSAL",
    };

    const sanitizedPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    );

    await prisma.salesCampaign.update({
      where: { id: campaignId },
      data: sanitizedPayload,
    });

    await prisma.campaignDeal.upsert({
      where: {
        campaignId_dealId: {
          campaignId,
          dealId: campaignDealId,
        },
      },
      update: {
        quantity: item.normalized.quantity ?? 0,
        actualSales: hasSalesAmount ? item.normalized.salesAmount ?? 0 : 0,
        feeRate:
          item.normalized.totalMarginRate != null
            ? item.normalized.totalMarginRate / 100
            : null,
      },
      create: {
        campaign: { connect: { id: campaignId } },
        deal: { connect: { id: campaignDealId } },
        quantity: item.normalized.quantity ?? 0,
        actualSales: hasSalesAmount ? item.normalized.salesAmount ?? 0 : 0,
        feeRate:
          item.normalized.totalMarginRate != null
            ? item.normalized.totalMarginRate / 100
            : null,
      },
    });

    if (isCreate) createCount += 1;
    if (!isCreate) updateCount += 1;
    await createImportRecord(
      prisma,
      batch.id,
      "pnl_csv",
      {
        sourceKey: item.sourceKey,
        rowHash: item.rowHash,
        action: isCreate ? "create" : "update",
        reviewReason: null,
      },
      item.row,
      sanitizedPayload,
      "SALES_CAMPAIGN",
      campaignId,
    );
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: "COMPLETED",
      finishedAt: new Date(),
      summary: JSON.stringify({
        createCount,
        updateCount,
        reviewCount,
      }),
    },
  });

  console.log(
    JSON.stringify(
      {
        artifactPath,
        ...summary,
        applySummary: {
          createCount,
          updateCount,
          reviewCount,
          batchId: batch.id,
        },
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
