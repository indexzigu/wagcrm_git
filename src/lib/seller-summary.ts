// 셀러 목록 SellerSummary 로더 — 단일 진실 원천.
//
// 왜 존재하나: 셀러 목록은 두 경로로 채워진다 — 페이지 초기 로드(getCachedSellersPageData)와
// react-query 갱신(GET /api/sellers). 이 둘이 서로 다른 필드 집합을 반환하면, 갱신 시점에
// aiComposite·acquisitionChannel 같은 필드가 사라져 "AI 점수 미분석"·"유입경로 저장 안 됨"으로
// 보인다(실제 DB엔 있음). 두 경로가 이 함수 하나만 쓰게 해서 필드 분기를 원천 차단한다.

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { tallyEffectiveCampaignCounts } from "@/lib/campaign-group-count";
import { tallySellerRuns, type SellerRunSignals } from "@/lib/seller-dormancy";
import { RUN_STATUSES } from "@/lib/recampaign-timing";
import type { SellerSummary, SnsType, CampaignStatus } from "@/lib/crm-types";

const sellerSummaryInclude = {
  agency: { select: { name: true } },
  referredBy: { select: { name: true, alias: true } },
  campaigns: {
    orderBy: { startDate: "desc" },
    include: { deal: { select: { dealName: true, brandName: true, partner: { select: { name: true } } } } },
    take: 12,
  },
  histories: {
    orderBy: { snapshotDate: "asc" },
    take: 12,
  },
  _count: { select: { campaigns: true } },
} satisfies Prisma.SellerInclude;

const DEFAULT_ORDER: Prisma.SellerOrderByWithRelationInput[] = [
  { isMonitored: "desc" },
  { createdAt: "desc" },
];

/**
 * 필터/정렬을 받아 리치 SellerSummary[] 를 반환한다. AI 프로필(별도 테이블)은 sellerId로 병합하며,
 * 테이블 미적용 환경에선 AI 없이 우아하게 축소한다(§12-3). 캐시 래핑은 호출부(getCachedSellersPageData)
 * 책임 — 이 함수 자체는 항상 최신 DB를 읽는다(GET /api/sellers 갱신 경로에서 신선도 보장).
 */
export async function loadSellerSummaries(opts?: {
  where?: Prisma.SellerWhereInput;
  orderBy?: Prisma.SellerOrderByWithRelationInput | Prisma.SellerOrderByWithRelationInput[];
}): Promise<SellerSummary[]> {
  const sellers = await getPrisma().seller.findMany({
    where: opts?.where,
    orderBy: opts?.orderBy ?? DEFAULT_ORDER,
    include: sellerSummaryInclude,
  });

  const aiBySeller = new Map<
    string,
    { compositeScore: number | null; confidence: string | null; analyzedAt: Date | null }
  >();
  try {
    const aiProfiles = await getPrisma().sellerAiProfile.findMany({
      select: { sellerId: true, compositeScore: true, confidence: true, analyzedAt: true },
    });
    for (const a of aiProfiles) {
      aiBySeller.set(a.sellerId, {
        compositeScore: a.compositeScore,
        confidence: a.confidence,
        analyzedAt: a.analyzedAt,
      });
    }
  } catch (e) {
    console.warn(
      "[seller-summary] SellerAiProfile 조회 실패 — AI 점수 없이 진행:",
      e instanceof Error ? e.message : e
    );
  }

  // 셀러별 유효 캠페인 수(그룹 = 1건, 오너 확정 2026-07-30) — DTO의 campaigns는 12건 캡이라
  // 캡 무관 집계가 필요하고, Prisma _count는 distinct(groupId)를 못 세므로 (sellerId, groupId)
  // groupBy 한 번으로 접는다(행 fetch 없음, P7 egress 규율). 실패 시 행 단위 _count로 폴백 —
  // 수치 의미가 잠깐 굵어질 뿐 "캠페인 없음" 오독은 없다.
  const effectiveCountBySeller = new Map<string, number>();
  let effectiveCountsOk = true;
  try {
    const grouped = await getPrisma().salesCampaign.groupBy({
      by: ["sellerId", "groupId"],
      _count: { _all: true },
    });
    const tally = tallyEffectiveCampaignCounts(
      grouped.map((g) => ({ sellerId: g.sellerId, groupId: g.groupId, rowCount: g._count._all })),
    );
    for (const [sellerId, count] of tally) effectiveCountBySeller.set(sellerId, count);
  } catch (e) {
    effectiveCountsOk = false;
    console.warn(
      "[seller-summary] 유효 캠페인 수 집계 실패 — 행 단위 _count로 폴백:",
      e instanceof Error ? e.message : e
    );
  }

  // 셀러별 마지막 실제 수집 시각(max snapshotDate) — 목록 DTO의 histories는 오래된순 12건만 담아
  // 최신 스냅샷이 빠질 수 있으므로 별도 집계로 정확한 신선도 신호를 만든다(§updatedAt 오염 회피).
  const lastSyncBySeller = new Map<string, Date>();
  try {
    const grouped = await getPrisma().sellersHistory.groupBy({
      by: ["sellerId"],
      _max: { snapshotDate: true },
    });
    for (const g of grouped) {
      if (g._max.snapshotDate) lastSyncBySeller.set(g.sellerId, g._max.snapshotDate);
    }
  } catch (e) {
    console.warn(
      "[seller-summary] SellersHistory 최신 스냅샷 집계 실패 — 신선도 없이 진행:",
      e instanceof Error ? e.message : e
    );
  }

  // 누적 캠페인 최근성 신호 — DTO의 campaigns는 startDate desc 12건 캡이라, 13건+ 셀러에서
  // 장기 진행 캠페인이 창 밖으로 밀리면 campaignRecency가 '종료'로 오판한다. 캡과 무관한
  // sellerId-only 경량 집계 3종으로 판정 근거를 따로 실어 보낸다(P7: 캠페인 행 fetch 금지).
  // DROPPED 제외는 campaignRecency(partner-seller-display.ts)의 판정 규칙과 한 몸이다.
  // 실패 시 필드를 아예 싣지 않아(undefined) 소비자가 캡 배열 폴백으로 판정하게 한다 —
  // false/null을 실으면 "캠페인 없음"으로 오독된다.
  const now = new Date();
  const activeSellerIds = new Set<string>();
  const upcomingSellerIds = new Set<string>();
  const lastEndBySeller = new Map<string, Date>();
  let recencySignalsOk = true;
  try {
    const nonDropped = { status: { not: "DROPPED" } } as const;
    const [activeRows, upcomingRows, endedRows] = await Promise.all([
      getPrisma().salesCampaign.groupBy({
        by: ["sellerId"],
        where: { ...nonDropped, startDate: { lte: now }, endDate: { gte: now } },
      }),
      getPrisma().salesCampaign.groupBy({
        by: ["sellerId"],
        where: { ...nonDropped, startDate: { gt: now } },
      }),
      getPrisma().salesCampaign.groupBy({
        by: ["sellerId"],
        where: { ...nonDropped, endDate: { lt: now } },
        _max: { endDate: true },
      }),
    ]);
    for (const r of activeRows) activeSellerIds.add(r.sellerId);
    for (const r of upcomingRows) upcomingSellerIds.add(r.sellerId);
    for (const r of endedRows) {
      if (r._max.endDate) lastEndBySeller.set(r.sellerId, r._max.endDate);
    }
  } catch (e) {
    recencySignalsOk = false;
    console.warn(
      "[seller-summary] 캠페인 최근성 집계 실패 — 캡 배열 폴백으로 진행:",
      e instanceof Error ? e.message : e
    );
  }

  // 휴면 티어 근거 — **과거에 실제로 진행된** 캠페인만 (F1 1단계, D20). 위 campaignCount 와
  // 모수가 다르다: 저기는 전 상태 누적이고 여기는 RUN_STATUSES ∩ 시작일 도래분이다.
  // 그래서 "누적 3회인데 진행 1회"(제안만 쌓인 셀러)가 구분된다 — 휴면(재접촉 대상)과
  // 1회성 이탈(온보딩 실패)은 개입이 다르므로 이 구분이 기능의 요점이다.
  // ⚠️ `where` 가 미래 시작일을 거르는 1차 방어다(tallySellerRuns 는 2차).
  // ⚠️ 관계 필터를 쓰지 않는다 — Prisma groupBy 의 관계 where 는 에러 없이 0건을 준다(P7).
  const runSignals = new Map<string, SellerRunSignals>();
  let runSignalsOk = true;
  try {
    const grouped = await getPrisma().salesCampaign.groupBy({
      by: ["sellerId", "groupId"],
      where: { status: { in: [...RUN_STATUSES] }, startDate: { lte: now } },
      _count: { _all: true },
      _max: { startDate: true },
    });
    const tally = tallySellerRuns(
      grouped.map((g) => ({
        sellerId: g.sellerId,
        groupId: g.groupId,
        rowCount: g._count._all,
        lastStartAt: g._max.startDate,
      })),
      now,
    );
    for (const [sellerId, signals] of tally) runSignals.set(sellerId, signals);
  } catch (e) {
    runSignalsOk = false;
    console.warn(
      "[seller-summary] 진행 이력 집계 실패 — 휴면 티어 없이 진행:",
      e instanceof Error ? e.message : e
    );
  }

  return sellers.map((seller) => ({
    id: seller.id,
    name: seller.name,
    // 목록의 신규(7일) 표시·등록일 정렬 근거 — 빠져 있으면 정렬이 폴백 0으로 조용히 무력화된다
    createdAt: seller.createdAt.toISOString(),
    alias: seller.alias ?? null,
    snsType: seller.snsType as SnsType,
    snsHandle: seller.snsHandle,
    currentFollowers: seller.currentFollowers,
    currentPostsCount: seller.currentPostsCount ?? null,
    profileBio: seller.profileBio ?? null,
    profilePicUrl: seller.profilePicUrl ?? null,
    profileExternalUrls: seller.profileExternalUrls ?? null,
    isMonitored: seller.isMonitored,
    portalToken: seller.portalToken ?? null,
    portalSlug: seller.portalSlug ?? null,
    hasPortalPassword: !!seller.portalPasswordHash,
    fitLevel: seller.fitLevel ?? null,
    // campaignCount = 유효 캠페인 수(그룹 1건) · campaignRowCount = 딜 단위 행 수(보조 표기용).
    // 캠페인 없는 셀러는 groupBy 행 자체가 없으므로 ?? 0 이 "확인된 0"이다.
    campaignCount: effectiveCountsOk
      ? (effectiveCountBySeller.get(seller.id) ?? 0)
      : seller._count.campaigns,
    campaignRowCount: seller._count.campaigns,
    category: seller.category ?? null,
    agencyId: seller.agencyId ?? null,
    agencyName: seller.agency?.name ?? null,
    channelUrl: seller.channelUrl ?? null,
    reviewer: seller.reviewer ?? null,
    personalCategory: seller.personalCategory ?? null,
    proposalProduct: seller.proposalProduct ?? null,
    proposalWaitlist: seller.proposalWaitlist ?? null,
    collaborationScore: seller.collaborationScore ?? null,
    adResponseScore: seller.adResponseScore ?? null,
    commentResponseScore: seller.commentResponseScore ?? null,
    activityFrequency: seller.activityFrequency ?? null,
    aiComposite: aiBySeller.get(seller.id)?.compositeScore ?? null,
    aiConfidence: aiBySeller.get(seller.id)?.confidence ?? null,
    aiAnalyzedAt: aiBySeller.get(seller.id)?.analyzedAt?.toISOString() ?? null,
    accountNumber: seller.accountNumber ?? null,
    email: seller.email ?? null,
    phoneNumber: seller.phoneNumber ?? null,
    mailingAddress: seller.mailingAddress ?? null,
    notes: seller.notes ?? null,
    lastReviewedAt: seller.lastReviewedAt?.toISOString() ?? null,
    lastSyncedAt: lastSyncBySeller.get(seller.id)?.toISOString() ?? null,
    acquisitionChannel: seller.acquisitionChannel ?? null,
    referredById: seller.referredById ?? null,
    referredByName: seller.referredBy ? (seller.referredBy.alias || seller.referredBy.name) : null,
    acquisitionNote: seller.acquisitionNote ?? null,
    availabilityNote: seller.availabilityNote ?? null,
    availabilityUpdatedAt: seller.availabilityUpdatedAt?.toISOString() ?? null,
    histories: seller.histories.map((history) => ({
      snapshotDate: history.snapshotDate.toISOString(),
      followersCount: history.followersCount,
      postsCount: history.postsCount ?? null,
    })),
    ...(recencySignalsOk
      ? {
          hasActiveCampaign: activeSellerIds.has(seller.id),
          hasUpcomingCampaign: upcomingSellerIds.has(seller.id),
          lastCampaignEndAt: lastEndBySeller.get(seller.id)?.toISOString() ?? null,
        }
      : {}),
    // 집계 성공 시 진행 이력이 없는 셀러는 "확인된 0회 · 판정 불가"다(행 자체가 없다).
    // 실패 시엔 필드를 아예 싣지 않아(undefined) 화면이 "0회"로 오독하지 않게 한다.
    ...(runSignalsOk
      ? {
          runCount: runSignals.get(seller.id)?.runCount ?? 0,
          lastRunStartAt: runSignals.get(seller.id)?.lastRunStartAt ?? null,
        }
      : {}),
    campaigns: seller.campaigns.map((campaign) => ({
      id: campaign.id,
      dealName: campaign.deal.dealName,
      brandName: campaign.deal.brandName ?? null,
      partnerName: campaign.deal.partner?.name ?? null,
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate.toISOString(),
      status: campaign.status as CampaignStatus,
      actualSales: campaign.actualSales != null ? Number(campaign.actualSales.toString()) : null,
    })),
  }));
}
