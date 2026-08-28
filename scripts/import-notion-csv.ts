import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { DealStatus } from "@prisma/client";
import { getPrisma } from "../src/lib/prisma";
import {
  buildSourceKey,
  extractInstagramHandle,
  extractRelationTitles,
  hashPayload,
  normalizeKey,
  parseCurrency,
  parseDate,
  parseFollowerCount,
  parsePercent,
  toNullableString,
} from "../src/lib/notion-import/normalize";

type TargetMode = "local" | "remote";
type CsvRow = Record<string, string>;
type ImportAction = "create" | "update" | "review";

const DEFAULT_PATHS = {
  partners:
    "/Users/z9/Downloads/거래처인덱스/거래처 인덱스 211cfeed461380f19b2af33a836da893_all.csv",
  sellers:
    "/Users/z9/Downloads/셀러디렉토리/셀러 디렉토리 211cfeed46138096bd63d692bbc6e345_all.csv",
  deals:
    "/Users/z9/Downloads/딜아카이브/딜 아카이브 211cfeed461380d88f94c078df33bc9b_all.csv",
  campaigns:
    "/Users/z9/Downloads/세일즈트래킹/세일즈 트래킹 211cfeed4613809bb948f5d072e1a1ce_all.csv",
} as const;

function getArg(flag: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

function parseCsv(path: string) {
  const text = readFileSync(path, "utf8");
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.filter((row) =>
    Object.values(row).some((value) => String(value ?? "").trim().length > 0),
  );
}

function countDuplicates(keys: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates.size;
}

function firstTitle(value: string | null) {
  return extractRelationTitles(value)[0] ?? toNullableString(value);
}

function summarize(rows: Array<{ action: string }>) {
  return rows.reduce(
    (accumulator, row) => {
      if (row.action === "create") accumulator.create += 1;
      if (row.action === "update") accumulator.update += 1;
      if (row.action === "review") accumulator.review += 1;
      return accumulator;
    },
    { create: 0, update: 0, review: 0 },
  );
}

function isApplyMode() {
  return process.argv.includes("--apply");
}

function isCampaignsOnlyMode() {
  return process.argv.includes("--campaigns-only");
}

function toDateTime(value: string | null) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function parseScheduleRange(value: string | null) {
  const normalized = toNullableString(value);
  if (!normalized) return { startDate: null, endDate: null };
  const [startRaw, endRaw] = normalized.split("→").map((entry) => entry.trim());
  const start = parseDate(startRaw);
  const end = parseDate(endRaw ?? startRaw);
  return {
    startDate: toDateTime(start),
    endDate: toDateTime(end ?? start),
  };
}

function parseKpiPercent(value: unknown) {
  const parsed = parsePercent(value);
  if (parsed == null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function cleanReviewReason(reason: Array<string | null | undefined>) {
  const compact = Array.from(new Set(reason.filter(Boolean) as string[]));
  return compact.length > 0 ? compact.join(",") : null;
}

function mapOutreachStatus(rowStatus: string | null, nextAction: string | null) {
  const status = normalizeKey(rowStatus);
  const action = normalizeKey(nextAction);
  if (
    status.includes("완료") ||
    status.includes("정산")
  ) {
    return "CONVERTED";
  }
  if (status.includes("진행대기")) return "PENDING_APPROVAL";
  if (status.includes("평가")) return "TESTING";
  if (status.includes("제안")) return "PROPOSED";
  if (
    status.includes("미진행") &&
    (action.includes("드랍") || action.includes("회신없음") || action.includes("보류"))
  ) {
    return "DROPPED";
  }
  return "PROPOSED";
}

function mapCampaignStatus(rowStatus: string | null, actualSales: number | null, nextAction: string | null) {
  const status = normalizeKey(rowStatus);
  const action = normalizeKey(nextAction);
  if (status.includes("정산")) return "SETTLEMENT_IN_PROGRESS";
  if (status.includes("완료")) return actualSales && actualSales > 0 ? "COMPLETED" : "SETTLEMENT_WAIT";
  if (status.includes("진행대기")) return "PREPARATION";
  if (action.includes("드랍") || action.includes("회신없음") || action.includes("보류")) return "DROPPED";
  return "PROPOSAL";
}

function shouldCreateCampaignRow(input: {
  status: string | null;
  rawSchedule: string | null;
  actualSales: number | null;
  nextAction: string | null;
}) {
  const normalizedStatus = normalizeKey(input.status);
  const normalizedAction = normalizeKey(input.nextAction);
  if (normalizedAction.includes("드랍") || normalizedAction.includes("회신없음")) {
    return false;
  }
  if (normalizedStatus.includes("완료") || normalizedStatus.includes("정산") || normalizedStatus.includes("진행대기")) {
    return true;
  }
  if (input.actualSales != null && input.actualSales > 0) return true;
  return Boolean(toNullableString(input.rawSchedule));
}

function resolveAction(reviewReason: string | null, hasExisting: boolean): ImportAction {
  if (reviewReason) return "review";
  return hasExisting ? "update" : "create";
}

async function main() {
  const target = (getArg("--target") ?? "local") as TargetMode;
  if (target === "local") {
    process.env.DATABASE_URL = "file:./dev.db";
    process.env.DIRECT_URL = "";
  }
  const prisma = getPrisma();

  const partnerRows = parseCsv(DEFAULT_PATHS.partners);
  const sellerRows = parseCsv(DEFAULT_PATHS.sellers);
  const dealRows = parseCsv(DEFAULT_PATHS.deals);
  const campaignRows = parseCsv(DEFAULT_PATHS.campaigns);

  const [dbPartners, dbSellers, dbDeals, dbCampaigns] = await Promise.all([
    prisma.partner.findMany({
      select: { id: true, name: true, contacts: { select: { name: true } } },
    }),
    prisma.seller.findMany({
      select: { id: true, name: true, alias: true, snsType: true, snsHandle: true },
    }),
    prisma.deal.findMany({
      select: { id: true, dealName: true, partner: { select: { name: true } } },
    }),
    prisma.salesCampaign.findMany({
      select: {
        id: true,
        salesCode: true,
        rawSchedule: true,
        seller: { select: { name: true } },
        deal: { select: { dealName: true } },
      },
    }),
  ]);

  const partnerMap = new Map(
    dbPartners.map((row) => [normalizeKey(row.name), row] as const),
  );
  const sellerHandleEntries = dbSellers
    .map((row) => [normalizeKey(row.snsHandle), row] as const)
    .filter(([key]) => Boolean(key));
  const sellerHandleMap = new Map(sellerHandleEntries);
  const sellerNameMap = new Map(
    dbSellers.map((row) => [normalizeKey(row.name), row] as const),
  );
  const sellerLookupMap = new Map<string, (typeof dbSellers)[number][]>();
  for (const seller of dbSellers) {
    const keys = [seller.name, seller.alias, seller.snsHandle].map((entry) => normalizeKey(entry));
    for (const key of keys) {
      if (!key) continue;
      const existing = sellerLookupMap.get(key) ?? [];
      sellerLookupMap.set(key, [...existing, seller]);
    }
  }
  const dealMap = new Map(
    dbDeals.map((row) => [
      buildSourceKey("deals", [row.partner?.name, row.dealName]),
      row,
    ] as const),
  );
  const dealNameMap = new Map(
    dbDeals.map((row) => [normalizeKey(row.dealName), row] as const),
  );
  const dealNameLookupMap = new Map<string, (typeof dbDeals)[number][]>();
  for (const deal of dbDeals) {
    const key = normalizeKey(deal.dealName);
    if (!key) continue;
    const existing = dealNameLookupMap.get(key) ?? [];
    dealNameLookupMap.set(key, [...existing, deal]);
  }
  const campaignMap = new Map(
    dbCampaigns.map((row) => [
      buildSourceKey("campaigns", [
        row.salesCode,
        row.seller.name,
        row.deal.dealName,
        row.rawSchedule,
      ]),
      row,
    ] as const),
  );

  const partnerAnalysis = partnerRows.map((row) => {
    const companyName = toNullableString(row["회사명"]);
    const contactName = toNullableString(row["담당자"]);
    const sourceKey = buildSourceKey("partners", [companyName]);
    const existing = partnerMap.get(normalizeKey(companyName));
    const reviewReason = !companyName ? "missing-company-name" : null;

    return {
      sourceKey,
      action: resolveAction(reviewReason, Boolean(existing)),
      companyName,
      contactName,
      reviewReason,
      rowHash: hashPayload(row),
    };
  });

  const sellerAnalysis = sellerRows.map((row) => {
    const sellerName = toNullableString(row["채널명"]);
    const handle = extractInstagramHandle(row["채널주소"]);
    const existingByHandle = handle ? sellerHandleMap.get(normalizeKey(handle)) : null;
    const existingByName = sellerName ? sellerNameMap.get(normalizeKey(sellerName)) : null;
    const reviewReason =
      !handle && !existingByName
        ? "missing-handle-and-no-name-match"
        : null;

    return {
      sourceKey: buildSourceKey("sellers", [handle ?? sellerName]),
      action: resolveAction(reviewReason, Boolean(existingByHandle || existingByName)),
      sellerName,
      handle,
      followers: parseFollowerCount(row["팔로워(만)"]),
      proposalStatus: toNullableString(row["제안진행"]),
      reviewReason,
      rowHash: hashPayload(row),
    };
  });

  const dealAnalysis = dealRows.map((row) => {
    const productName = toNullableString(row["상품"]);
    const partnerOrBrand = toNullableString(row["회사명"]) ?? toNullableString(row["브랜드"]);
    const sourceKey = buildSourceKey("deals", [partnerOrBrand, productName]);
    const existing = dealMap.get(sourceKey);
    const existingByName = productName ? dealNameMap.get(normalizeKey(productName)) : null;
    const reviewReason =
      !productName || !partnerOrBrand
        ? "missing-partner-or-product"
        : existingByName && !existing
          ? "product-name-match-with-different-partner"
          : null;

    return {
      sourceKey,
      action: resolveAction(reviewReason, Boolean(existing)),
      dealName: productName,
      partnerOrBrand,
      costPrice: parsePercent(row["공급가"]),
      sellingPrice: parsePercent(row["공구가"]),
      totalCommissionRate: parsePercent(row["총 수수료"]),
      brokerageCommissionRate: parsePercent(row["중개 수수료"]),
      reviewReason,
      rowHash: hashPayload(row),
    };
  });

  const campaignAnalysis = campaignRows.map((row) => {
    const salesCode = toNullableString(row["세일즈코드"]);
    const sellerName = firstTitle(row["셀러 정보"] ?? row["셀러 정보"]);
    const dealName = firstTitle(row["딜 리스트"]);
    const rawSchedule = toNullableString(row["진행일정"]);
    const status = toNullableString(row["단계"]);
    const nextAction = toNullableString(row["다음 업무"]);
    const actualSales = parseCurrency(row["매출"]);
    const dealCandidates = dealName ? dealNameLookupMap.get(normalizeKey(dealName)) ?? [] : [];
    const sellerCandidates = sellerName ? sellerLookupMap.get(normalizeKey(sellerName)) ?? [] : [];
    const existingDeal = dealCandidates.length === 1 ? dealCandidates[0] : null;
    const existingSeller = sellerCandidates.length === 1 ? sellerCandidates[0] : null;
    const sourceKey = buildSourceKey("campaigns", [
      salesCode,
      sellerName,
      dealName,
      rawSchedule ?? parseDate(row["생성 일시"]),
    ]);
    const existing = campaignMap.get(sourceKey);

    const reviewReason = cleanReviewReason([
      !dealName ? "missing-deal-name" : null,
      !sellerName ? "missing-seller-name" : null,
      dealCandidates.length === 0 ? "missing-deal-match" : null,
      dealCandidates.length > 1 ? "ambiguous-deal-match" : null,
      sellerCandidates.length === 0 ? "missing-seller-match" : null,
      sellerCandidates.length > 1 ? "ambiguous-seller-match" : null,
    ]);

    return {
      sourceKey,
      action: resolveAction(reviewReason, Boolean(existing)),
      salesCode,
      sellerName,
      dealName,
      nextAction,
      status,
      actualSales,
      sourceCreatedAt: parseDate(row["생성 일시"]),
      rawSchedule,
      shouldCreateCampaign: shouldCreateCampaignRow({
        status,
        rawSchedule,
        actualSales,
        nextAction,
      }),
      reviewReason,
      rowHash: hashPayload(row),
    };
  });

  const report = {
    mode: isApplyMode() ? "apply" : "dry-run",
    target,
    generatedAt: new Date().toISOString(),
    counts: {
      database: {
        partners: dbPartners.length,
        sellers: dbSellers.length,
        deals: dbDeals.length,
        campaigns: dbCampaigns.length,
      },
      csv: {
        partners: partnerRows.length,
        sellers: sellerRows.length,
        deals: dealRows.length,
        campaigns: campaignRows.length,
      },
    },
    summary: {
      partners: summarize(partnerAnalysis),
      sellers: summarize(sellerAnalysis),
      deals: summarize(dealAnalysis),
      campaigns: summarize(campaignAnalysis),
    },
    reviewSamples: {
      partners: partnerAnalysis.filter((row) => row.action === "review").slice(0, 10),
      sellers: sellerAnalysis.filter((row) => row.action === "review").slice(0, 10),
      deals: dealAnalysis.filter((row) => row.action === "review").slice(0, 10),
      campaigns: campaignAnalysis.filter((row) => row.action === "review").slice(0, 10),
    },
    duplicates: {
      partnerSourceKeys: countDuplicates(partnerAnalysis.map((row) => row.sourceKey)),
      sellerSourceKeys: countDuplicates(sellerAnalysis.map((row) => row.sourceKey)),
      dealSourceKeys: countDuplicates(dealAnalysis.map((row) => row.sourceKey)),
      campaignSourceKeys: countDuplicates(campaignAnalysis.map((row) => row.sourceKey)),
    },
  };

  const artifactDir = join(process.cwd(), "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(
    artifactDir,
    `notion-import-${isApplyMode() ? "apply" : "dry-run"}-${target}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);

  if (isApplyMode()) {
    await applyImport({
      prisma,
      target,
      partnerRows,
      sellerRows,
      dealRows,
      campaignRows,
      partnerAnalysis,
      sellerAnalysis,
      dealAnalysis,
      campaignAnalysis,
    });
  }

  console.log(JSON.stringify({ artifactPath, ...report }, null, 2));
  await prisma.$disconnect();
}

async function applyImport(input: {
  prisma: ReturnType<typeof getPrisma>;
  target: TargetMode;
  partnerRows: CsvRow[];
  sellerRows: CsvRow[];
  dealRows: CsvRow[];
  campaignRows: CsvRow[];
  partnerAnalysis: Array<{
    sourceKey: string;
    action: ImportAction;
    rowHash: string;
    reviewReason: string | null;
  }>;
  sellerAnalysis: Array<{
    sourceKey: string;
    action: ImportAction;
    rowHash: string;
    reviewReason: string | null;
  }>;
  dealAnalysis: Array<{
    sourceKey: string;
    action: ImportAction;
    rowHash: string;
    reviewReason: string | null;
  }>;
  campaignAnalysis: Array<{
    sourceKey: string;
    action: ImportAction;
    salesCode: string | null;
    sellerName: string | null;
    dealName: string | null;
    nextAction: string | null;
    status: string | null;
    actualSales: number | null;
    sourceCreatedAt: string | null;
    rawSchedule: string | null;
    shouldCreateCampaign: boolean;
    rowHash: string;
    reviewReason: string | null;
  }>;
}) {
  const campaignsOnly = isCampaignsOnlyMode();
  const batch = await input.prisma.importBatch.create({
    data: {
      sourceSystem: "NOTION",
      targetDatabase: input.target.toUpperCase(),
      mode: "APPLY",
      status: "RUNNING",
      summary: campaignsOnly
        ? "Notion campaign/task import apply (campaigns-only)"
        : "SQLite-first Notion import apply",
    },
  });

  let createCount = 0;
  let updateCount = 0;
  let reviewCount = 0;
  const taskByPair = new Map<string, { id: string; linkedCampaignId: string | null }>();

  if (!campaignsOnly) {
    for (const [index, row] of input.partnerRows.entries()) {
    const analysis = input.partnerAnalysis[index];
    const companyName = toNullableString(row["회사명"]);
    const contactName = toNullableString(row["담당자"]);
    const partnerBase = {
      type: mapPartnerType(row["구분"]),
      contactInfo: contactName,
      companyStatus: toNullableString(row["상태"]),
      companyRole: toNullableString(row["선택"]),
      notes: toNullableString(row["기타"]),
      lastContactAt: toDateTime(parseDate(row["컨택"])),
      bankAccount: null,
    };

    if (analysis.action === "review" || !companyName) {
      reviewCount += 1;
      await createImportRecord(
        input.prisma,
        batch.id,
        "partners",
        analysis,
        row,
        { name: companyName, ...partnerBase },
      );
      continue;
    }

    const normalized = {
      name: companyName,
      ...partnerBase,
    };

    const existing = await input.prisma.partner.findFirst({
      where: { name: companyName },
      include: { contacts: true },
    });

    const partner = existing
      ? await input.prisma.partner.update({
          where: { id: existing.id },
          data: normalized,
        })
      : await input.prisma.partner.create({
          data: normalized,
        });

    if (contactName) {
      const existingContact = existing?.contacts.find((contact) => contact.name === contactName);
      if (existingContact) {
        await input.prisma.partnerContact.update({
          where: { id: existingContact.id },
          data: {
            role: toNullableString(row["선택"]),
            email: toNullableString(row["이메일"]),
            phoneNumber: toNullableString(row["전화번호"]),
            notes: toNullableString(row["기타"]),
            lastContactAt: toDateTime(parseDate(row["컨택"])),
          },
        });
      } else {
        await input.prisma.partnerContact.create({
          data: {
            partnerId: partner.id,
            name: contactName,
            role: toNullableString(row["선택"]),
            email: toNullableString(row["이메일"]),
            phoneNumber: toNullableString(row["전화번호"]),
            notes: toNullableString(row["기타"]),
            lastContactAt: toDateTime(parseDate(row["컨택"])),
          },
        });
      }
    }

    if (analysis.action === "create") createCount += 1;
    if (analysis.action === "update") updateCount += 1;
    await createImportRecord(input.prisma, batch.id, "partners", analysis, row, normalized, "PARTNER", partner.id);
    }

    for (const [index, row] of input.sellerRows.entries()) {
    const analysis = input.sellerAnalysis[index];
    const name = toNullableString(row["채널명"]);
    const handle = extractInstagramHandle(row["채널주소"]);
    const sellerBase = {
      snsType: mapSnsType(row["플랫폼"]),
      currentFollowers: parseFollowerCount(row["팔로워(만)"]) ?? 0,
      category: toNullableString(row["카테고리"]),
      channelUrl: toNullableString(row["채널주소"]),
      reviewer: toNullableString(row["검토담당"]),
      personalCategory: toNullableString(row["개인분류"]),
      fitLevel: toNullableString(row["적합성"]),
      proposalStatus: toNullableString(row["제안진행"]),
      proposalProduct: toNullableString(row["제안상품"]),
      proposalWaitlist: toNullableString(row["제안대기"]),
      collaborationScore: toNullableString(row["공구활성화"]),
      adResponseScore: toNullableString(row["광고반응"]),
      commentResponseScore: toNullableString(row["댓글반응"]),
      activityFrequency: toNullableString(row["활동빈도"]),
      accountNumber: toNullableString(row["결제계좌"]),
      email: toNullableString(row["이메일"]),
      phoneNumber: toNullableString(row["전화번호"]),
      mailingAddress: toNullableString(row["주소"]),
      notes: toNullableString(row["비고"]),
      lastReviewedAt: toDateTime(parseDate(row["업데이트"])),
    };

    if (analysis.action === "review" || !name) {
      reviewCount += 1;
      await createImportRecord(
        input.prisma,
        batch.id,
        "sellers",
        analysis,
        row,
        { name, snsHandle: handle ?? normalizeKey(name), ...sellerBase },
      );
      continue;
    }

    const normalized = {
      name,
      snsHandle: handle ?? normalizeKey(name),
      ...sellerBase,
    };

    const existing = handle
      ? await input.prisma.seller.findFirst({
          where: {
            snsType: normalized.snsType,
            snsHandle: normalized.snsHandle,
          },
        })
      : await input.prisma.seller.findFirst({
          where: { name },
        });

    const seller = existing
      ? await input.prisma.seller.update({
          where: { id: existing.id },
          data: normalized,
        })
      : await input.prisma.seller.create({
          data: normalized as {
            name: string;
            snsType: string;
            snsHandle: string;
            currentFollowers: number;
          },
        });

    // Notion 업데이트 날짜(lastReviewedAt)와 당시의 팔로워 정보를 SellersHistory에 누적
    if (seller.lastReviewedAt && seller.currentFollowers > 0) {
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstTime = new Date(seller.lastReviewedAt.getTime() + kstOffset);
      const snapshotDate = new Date(
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

      await input.prisma.sellersHistory.upsert({
        where: {
          sellerId_snapshotDate: {
            sellerId: seller.id,
            snapshotDate,
          },
        },
        update: {
          source: "IMPORT", // 기존 과거 수집 팔로워 정보 유실 방지
        },
        create: {
          sellerId: seller.id,
          snapshotDate,
          followersCount: seller.currentFollowers,
          source: "IMPORT",
        },
      });
    }

    if (analysis.action === "create") createCount += 1;
    if (analysis.action === "update") updateCount += 1;
    await createImportRecord(input.prisma, batch.id, "sellers", analysis, row, normalized, "SELLER", seller.id);
    }

    for (const [index, row] of input.dealRows.entries()) {
    const analysis = input.dealAnalysis[index];
    const dealName = toNullableString(row["상품"]);
    const partnerName = toNullableString(row["회사명"]) ?? toNullableString(row["브랜드"]);
    if (analysis.action === "review" || !dealName || !partnerName) {
      reviewCount += 1;
      await createImportRecord(input.prisma, batch.id, "deals", analysis, row, row);
      continue;
    }

    const partner = await input.prisma.partner.findFirst({
      where: { name: partnerName },
    });

    if (!partner) {
      reviewCount += 1;
      await createImportRecord(
        input.prisma,
        batch.id,
        "deals",
        { ...analysis, action: "review", reviewReason: "missing-partner-after-apply" },
        row,
        row,
      );
      continue;
    }

    const normalized = {
      dealName,
      brandName: toNullableString(row["브랜드"]),
      partnerCompanyName: toNullableString(row["회사명"]),
      costPrice: parsePercent(row["공급가"]) ?? 0,
      sellingPrice: parsePercent(row["공구가"]) ?? 0,
      listPrice: parsePercent(row["정상가"]),
      floorPrice: parsePercent(row["최저가"]),
      discountRate: parsePercent(row["할인율"]),
      totalCommissionRate: parsePercent(row["총 수수료"]),
      brokerageCommissionRate: parsePercent(row["중개 수수료"]),
      baseMarginPolicy: JSON.stringify(defaultMarginPolicy()),
      status: mapDealStatus(row["진행"]),
      sourcingMemo: toNullableString(row["비고"]),
      candidateSellers: extractRelationTitles(row["컨택트 리스트"]).join(", "),
      partnerId: partner.id,
    };

    const existing = await input.prisma.deal.findFirst({
      where: {
        dealName,
        partnerId: partner.id,
      },
    });

    const deal = existing
      ? await input.prisma.deal.update({
          where: { id: existing.id },
          data: normalized,
        })
      : await input.prisma.deal.create({
          data: normalized,
        });

    if (analysis.action === "create") createCount += 1;
    if (analysis.action === "update") updateCount += 1;
    await createImportRecord(input.prisma, batch.id, "deals", analysis, row, normalized, "DEAL", deal.id);
    }
  }

  for (const [index, row] of input.campaignRows.entries()) {
    const analysis = input.campaignAnalysis[index];
    const seller = analysis.sellerName
      ? await input.prisma.seller.findFirst({ where: { name: analysis.sellerName } })
      : null;
    const dealCandidates = analysis.dealName
      ? await input.prisma.deal.findMany({ where: { dealName: analysis.dealName }, select: { id: true, dealName: true } })
      : [];
    const deal = dealCandidates.length === 1 ? dealCandidates[0] : null;
    const matchingReviewReason = cleanReviewReason([
      analysis.reviewReason,
      !seller ? "missing-seller-after-apply" : null,
      dealCandidates.length === 0 ? "missing-deal-after-apply" : null,
      dealCandidates.length > 1 ? "ambiguous-deal-after-apply" : null,
    ]);

    if (!seller || !deal || matchingReviewReason) {
      reviewCount += 1;
      await createImportRecord(
        input.prisma,
        batch.id,
        "campaigns",
        { ...analysis, action: "review", reviewReason: matchingReviewReason },
        row,
        row,
      );
      continue;
    }

    const pairKey = `${deal.id}::${seller.id}`;
    let taskRef = taskByPair.get(pairKey) ?? null;
    if (!taskRef) {
      const existingTask = await input.prisma.salesTask.findFirst({
        where: {
          dealId: deal.id,
          sellerId: seller.id,
        },
        orderBy: [{ linkedCampaignId: "desc" }, { updatedAt: "desc" }],
        select: { id: true, linkedCampaignId: true },
      });
      if (existingTask) {
        taskRef = { id: existingTask.id, linkedCampaignId: existingTask.linkedCampaignId };
        taskByPair.set(pairKey, taskRef);
      }
    }

    const outreachStatus = mapOutreachStatus(analysis.status, analysis.nextAction);
    const reminderDate = outreachStatus === "PROPOSED" ? toDateTime(analysis.sourceCreatedAt ?? parseDate(row["생성 일시"])) : null;
    const dropReason = outreachStatus === "DROPPED" ? analysis.nextAction ?? toNullableString(row["비고"]) ?? "CSV 드랍" : null;

    const taskPayload = {
      status: outreachStatus,
      proposalSentAt: toDateTime(analysis.sourceCreatedAt ?? parseDate(row["생성 일시"])) ?? new Date(),
      respondedAt: outreachStatus === "PROPOSED" ? null : toDateTime(analysis.sourceCreatedAt ?? parseDate(row["생성 일시"])),
      confirmedAt:
        outreachStatus === "PENDING_APPROVAL" || outreachStatus === "CONVERTED"
          ? toDateTime(analysis.sourceCreatedAt ?? parseDate(row["생성 일시"]))
          : null,
      nextReminderAt: reminderDate,
      droppedAt: outreachStatus === "DROPPED" ? new Date() : null,
      dropReason,
      proposalMessage: analysis.nextAction,
      testingMemo: toNullableString(row["비고"]),
    };

    const task = taskRef
      ? await input.prisma.salesTask.update({
          where: { id: taskRef.id },
          data: taskPayload,
          select: { id: true, linkedCampaignId: true },
        })
      : await input.prisma.salesTask.create({
          data: {
            dealId: deal.id,
            sellerId: seller.id,
            ...taskPayload,
          },
          select: { id: true, linkedCampaignId: true },
        });

    taskByPair.set(pairKey, { id: task.id, linkedCampaignId: task.linkedCampaignId });
    if (!taskRef) createCount += 1;
    if (taskRef) updateCount += 1;

    if (!analysis.shouldCreateCampaign) {
      await createImportRecord(
        input.prisma,
        batch.id,
        "sales_tasks",
        { ...analysis, action: taskRef ? "update" : "create" },
        row,
        {
          dealId: deal.id,
          sellerId: seller.id,
          status: outreachStatus,
        },
        "SALES_TASK",
        task.id,
      );
      continue;
    }

    const schedule = parseScheduleRange(analysis.rawSchedule);
    const fallbackDate = toDateTime(analysis.sourceCreatedAt ?? parseDate(row["생성 일시"])) ?? new Date();
    const startDate = schedule.startDate ?? fallbackDate;
    const endDate = schedule.endDate ?? startDate;
    const feeRate = parseKpiPercent(row["수수료%"]);
    const sellerMarginRate = parseKpiPercent(row["셀러%"]);
    const campaignPayload = {
      dealId: deal.id,
      sellerId: seller.id,
      status: mapCampaignStatus(analysis.status, analysis.actualSales, analysis.nextAction),
      salesCode: analysis.salesCode,
      nextAction: analysis.nextAction,
      notesFromImport: toNullableString(row["비고"]),
      rawSchedule: analysis.rawSchedule,
      sourceCreatedAt: toDateTime(analysis.sourceCreatedAt),
      startDate,
      endDate,
      salesChannel: "OWN_MALL",
      baseNaverLink: "",
      generatedTrackingLink: `https://import.local/${analysis.sourceKey}`,
      // 🪤 `targetSales: 0` 이 있었다 — 그 필드는 「목표 매출 제거」 때 **스키마째
      //    사라졌고**(`docs/private/kiro/specs/ux-fixes-and-field-editing` Requirement 4), 넣은 채
      //    실행하면 Prisma 가 Unknown argument 로 거부한다.
      //    ⚠️ 이건 **타입체크로도 안 잡혔다**: 이 객체는 중간 변수(`campaignPayload`)를
      //    거쳐 Prisma 로 가는데, 초과 속성 검사는 **객체 리터럴을 직접 넘길 때만**
      //    작동한다. 같은 모양이 다른 스크립트에도 있을 수 있다.
      actualSales: analysis.actualSales,
      quantity: parseCurrency(row["주문건수"]),
      itemCount: parseCurrency(row["주문수량"]),
      operatingExpense: parseCurrency(row["운영비용"]),
      operatingProfit: parseCurrency(row["운영이익"]),
      sellerExpense: parseCurrency(row["셀러비용"]),
      settlementSales: parseCurrency(row["정산매출"]),
      expectedDepositDate: toDateTime(parseDate(row["정산입금"])),
      expectedPayoutDate: toDateTime(parseDate(row["정산지급"])),
      totalMarginRate: feeRate ?? 0,
      sellerMarginRate: sellerMarginRate ?? 0,
      netMarginRate: feeRate != null && sellerMarginRate != null ? feeRate - sellerMarginRate : 0,
    };

    const existingCampaign = await input.prisma.salesCampaign.findFirst({
      where: {
        salesCode: analysis.salesCode ?? undefined,
        sellerId: seller.id,
        dealId: deal.id,
        rawSchedule: analysis.rawSchedule ?? undefined,
      },
      select: { id: true },
    });

    const campaign = existingCampaign
      ? await input.prisma.salesCampaign.update({
          where: { id: existingCampaign.id },
          data: campaignPayload,
        })
      : await input.prisma.salesCampaign.create({
          data: campaignPayload,
        });

    await input.prisma.campaignDeal.upsert({
      where: {
        campaignId_dealId: {
          campaignId: campaign.id,
          dealId: deal.id,
        },
      },
      update: {
        quantity: parseCurrency(row["주문건수"]) ?? 0,
        actualSales: analysis.actualSales ?? 0,
        feeRate: feeRate,
      },
      create: {
        campaign: { connect: { id: campaign.id } },
        deal: { connect: { id: deal.id } },
        quantity: parseCurrency(row["주문건수"]) ?? 0,
        actualSales: analysis.actualSales ?? 0,
        feeRate: feeRate,
      },
    });

    if (task.linkedCampaignId !== campaign.id) {
      await input.prisma.salesTask.update({
        where: { id: task.id },
        data: { linkedCampaignId: campaign.id },
      });
    }

    if (existingCampaign) updateCount += 1;
    if (!existingCampaign) createCount += 1;
    await createImportRecord(
      input.prisma,
      batch.id,
      "campaigns",
      { ...analysis, action: existingCampaign ? "update" : "create" },
      row,
      campaignPayload,
      "SALES_CAMPAIGN",
      campaign.id,
    );
  }

  await input.prisma.importBatch.update({
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
}

async function createImportRecord(
  prisma: ReturnType<typeof getPrisma>,
  batchId: string,
  sourceTable: string,
  analysis: {
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
    sourceKey: analysis.sourceKey,
    rowHash: analysis.rowHash,
    action: analysis.action.toUpperCase(),
    targetEntity,
    targetId,
    reviewReason: analysis.reviewReason,
    rawPayload: JSON.stringify(rawPayload),
    normalizedData: JSON.stringify(normalizedData),
  };

  await prisma.importSourceRecord.upsert({
    where: {
      batchId_sourceTable_sourceKey: {
        batchId,
        sourceTable,
        sourceKey: analysis.sourceKey,
      },
    },
    create: payload,
    update: payload,
  });
}

function mapPartnerType(value: string | null | undefined) {
  const normalized = normalizeKey(value);
  if (normalized.includes("대행")) return "AGENCY";
  if (normalized.includes("에이전")) return "AGENT";
  if (normalized.includes("벤더") || normalized.includes("수입제조")) return "VENDOR";
  return "BRAND";
}

function mapSnsType(value: string | null | undefined) {
  const normalized = normalizeKey(value);
  return normalized.includes("youtube") || normalized.includes("유튜브") ? "YOUTUBE" : "INSTAGRAM";
}

function mapDealStatus(value: string | null | undefined): DealStatus {
  const normalized = normalizeKey(value);
  if (normalized.includes("진행")) return "ARCHIVED";
  if (normalized.includes("드랍") || normalized.includes("보류")) return "DROPPED";
  if (normalized.includes("샘플")) return "SAMPLE_TESTING";
  if (normalized.includes("협의") || normalized.includes("컨택")) return "NEGOTIATING";
  return "SOURCING";
}

function defaultMarginPolicy() {
  return {
    byChannel: {
      OWN_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
      SELLER_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
      BRAND_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
    },
  };
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
