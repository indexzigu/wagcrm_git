/**
 * Phase 0-3: 캠페인 데이터 정합성 점검 (read-only)
 *
 * 최근 SalesCampaign 최대 30건(최신순)에 대해:
 *   1. 필수값 누락 — deal/seller 연결 없음, 기간(startDate/endDate) 누락·역전
 *   2. 중복 의심 — 같은 (dealId, sellerId) 조합에서 캠페인 기간이 겹치는 쌍
 *   3. 정산 정합 — isPayoutCompleted=true인데 isDepositReceived=false(순서 이상),
 *      settlementChecklist 없음
 *   4. 재무 이상치 — 매출(actualSales/settlementSales)>0인데 CampaignDeal 0건,
 *      마진(netMarginRate 또는 operatingProfit) 음수인데 사은품 언급(노트/캠페인명) 없음
 *
 * DB 쓰기 없음. 콘솔 출력만.
 */
import { getPrisma } from "../src/lib/prisma";

const MAX_CAMPAIGNS = 30;
const GIFT_KEYWORDS = ["사은품", "증정", "무상", "gift"];

type CampaignWithRelations = Awaited<ReturnType<typeof fetchCampaigns>>[number];

async function fetchCampaigns(prisma: ReturnType<typeof getPrisma>) {
  return prisma.salesCampaign.findMany({
    take: MAX_CAMPAIGNS,
    orderBy: { createdAt: "desc" },
    include: {
      deal: { select: { id: true, dealName: true } },
      seller: { select: { id: true, name: true } },
      campaignDeals: { select: { id: true, actualSales: true } },
      settlementChecklist: { select: { id: true } },
      notes: { select: { content: true } },
    },
  });
}

function fmt(c: CampaignWithRelations) {
  const name = c.campaignName || c.deal?.dealName || "(이름없음)";
  return `${c.id} · ${name} · seller=${c.seller?.name ?? "없음"}`;
}

function hasGiftMention(c: CampaignWithRelations): boolean {
  const haystacks = [
    c.campaignName ?? "",
    c.notesFromImport ?? "",
    ...c.notes.map((n) => n.content ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return GIFT_KEYWORDS.some((kw) => haystacks.includes(kw.toLowerCase()));
}

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  const n = typeof d === "object" && d !== null && "toNumber" in d
    ? (d as { toNumber: () => number }).toNumber()
    : Number(d);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const prisma = getPrisma();
  const campaigns = await fetchCampaigns(prisma);

  console.log(`캠페인 데이터 정합성 점검 (최신 ${campaigns.length}건 대상, read-only)`);
  console.log("=".repeat(70));

  // 1. 필수값 누락
  const missingRequired: { campaign: CampaignWithRelations; reasons: string[] }[] = [];
  for (const c of campaigns) {
    const reasons: string[] = [];
    if (!c.dealId || !c.deal) reasons.push("deal 연결 없음");
    if (!c.sellerId || !c.seller) reasons.push("seller 연결 없음");
    if (!c.startDate) reasons.push("startDate 누락");
    if (!c.endDate) reasons.push("endDate 누락");
    if (c.startDate && c.endDate && c.startDate.getTime() > c.endDate.getTime()) {
      reasons.push(`기간 역전 (start=${c.startDate.toISOString().slice(0, 10)} > end=${c.endDate.toISOString().slice(0, 10)})`);
    }
    if (reasons.length > 0) missingRequired.push({ campaign: c, reasons });
  }

  // 2. 중복 의심 (같은 dealId+sellerId, 기간 겹침)
  type Pair = { a: CampaignWithRelations; b: CampaignWithRelations };
  const duplicateSuspects: Pair[] = [];
  const byDealSeller = new Map<string, CampaignWithRelations[]>();
  for (const c of campaigns) {
    if (!c.dealId || !c.sellerId) continue;
    const key = `${c.dealId}::${c.sellerId}`;
    const arr = byDealSeller.get(key) ?? [];
    arr.push(c);
    byDealSeller.set(key, arr);
  }
  for (const group of byDealSeller.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!a.startDate || !a.endDate || !b.startDate || !b.endDate) continue;
        const overlap = a.startDate.getTime() <= b.endDate.getTime() && b.startDate.getTime() <= a.endDate.getTime();
        if (overlap) duplicateSuspects.push({ a, b });
      }
    }
  }

  // 3. 정산 정합
  const settlementIssues: { campaign: CampaignWithRelations; reasons: string[] }[] = [];
  for (const c of campaigns) {
    const reasons: string[] = [];
    if (c.isPayoutCompleted && !c.isDepositReceived) {
      reasons.push("isPayoutCompleted=true 인데 isDepositReceived=false (순서 이상)");
    }
    if (!c.settlementChecklist) {
      reasons.push("settlementChecklist 없음");
    }
    if (reasons.length > 0) settlementIssues.push({ campaign: c, reasons });
  }

  // 4. 재무 이상치
  const financialAnomalies: { campaign: CampaignWithRelations; reasons: string[] }[] = [];
  for (const c of campaigns) {
    const reasons: string[] = [];
    const actualSales = decimalToNumber(c.actualSales) ?? 0;
    const settlementSales = decimalToNumber(c.settlementSales) ?? 0;
    const revenue = actualSales || settlementSales;
    if (revenue > 0 && c.campaignDeals.length === 0) {
      reasons.push(`매출 ${revenue.toLocaleString()}원 있는데 CampaignDeal 0건`);
    }
    const netMarginRate = decimalToNumber(c.netMarginRate);
    const operatingProfit = decimalToNumber(c.operatingProfit);
    const negativeMargin =
      (netMarginRate !== null && netMarginRate < 0) ||
      (operatingProfit !== null && operatingProfit < 0);
    if (negativeMargin && !hasGiftMention(c)) {
      const marginDesc = [
        netMarginRate !== null ? `netMarginRate=${netMarginRate}` : null,
        operatingProfit !== null ? `operatingProfit=${operatingProfit}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      reasons.push(`마진 음수(${marginDesc})인데 사은품 언급 없음`);
    }
    if (reasons.length > 0) financialAnomalies.push({ campaign: c, reasons });
  }

  // 출력
  console.log(`\n[1] 필수값 누락: ${missingRequired.length}건`);
  for (const { campaign, reasons } of missingRequired) {
    console.log(`  - ${fmt(campaign)}`);
    for (const r of reasons) console.log(`      · ${r}`);
  }

  console.log(`\n[2] 중복 의심 (동일 deal+seller, 기간 겹침): ${duplicateSuspects.length}쌍`);
  for (const { a, b } of duplicateSuspects) {
    console.log(`  - ${fmt(a)}`);
    console.log(`    vs ${fmt(b)}`);
  }

  console.log(`\n[3] 정산 정합 문제: ${settlementIssues.length}건`);
  for (const { campaign, reasons } of settlementIssues) {
    console.log(`  - ${fmt(campaign)}`);
    for (const r of reasons) console.log(`      · ${r}`);
  }

  console.log(`\n[4] 재무 이상치: ${financialAnomalies.length}건`);
  for (const { campaign, reasons } of financialAnomalies) {
    console.log(`  - ${fmt(campaign)}`);
    for (const r of reasons) console.log(`      · ${r}`);
  }

  const problemIds = new Set<string>();
  for (const { campaign } of missingRequired) problemIds.add(campaign.id);
  for (const { a, b } of duplicateSuspects) {
    problemIds.add(a.id);
    problemIds.add(b.id);
  }
  for (const { campaign } of settlementIssues) problemIds.add(campaign.id);
  for (const { campaign } of financialAnomalies) problemIds.add(campaign.id);

  console.log("\n" + "=".repeat(70));
  console.log(`총 ${campaigns.length}건 점검, 이상 ${problemIds.size}건`);
}

main()
  .catch((err) => {
    console.error("점검 스크립트 실행 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const prisma = getPrisma();
    await prisma.$disconnect();
  });
