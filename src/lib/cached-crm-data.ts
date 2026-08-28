import { cacheLife, cacheTag } from "next/cache";
import { parseBaseMarginPolicy } from "@/lib/base-margin-policy";
import { getDashboardData } from "@/lib/dashboard-data";
import { getDesktopDashboardData } from "@/lib/desktop-dashboard";
import type {
  ApiCallLogRow,
  CampaignStatus,
  DashboardData,
  DealStatus,
  PartnerType,
} from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";
import { findDealsNeedingReviewLink } from "@/lib/order-converter/review-link";
import { getMobileSettlementCampaigns } from "@/lib/mobile-settlement-data";
import { loadSellerSummaries } from "@/lib/seller-summary";
import { CRM_CACHE_TAGS } from "@/lib/cache-tags";
import { CRM_CACHE_LIFE } from "@/lib/cache-policy";
import { toAssetRow } from "@/lib/assets";
import { toCampaignRow } from "@/lib/campaign-row";
import {
  SUPABASE_FREE_STORAGE_LIMIT_BYTES,
  SUPABASE_STORAGE_WARNING_BYTES,
} from "@/lib/asset-storage";
import { buildPnlReportModel } from "@/lib/pnl-report";

type DashboardWorkspace = "pipeline" | "settlement";

/**
 * Cached initial snapshot for shared CRM dashboard-style pages.
 */
export async function getCachedDashboardData(workspace?: DashboardWorkspace) {
  "use cache";
  // pipeline만 hot — settlement는 월 단위 신선도(쓰기·크론 태그가 즉시성 담당)라 warm으로 강등(2026-07-10)
  cacheLife(workspace === "pipeline" ? CRM_CACHE_LIFE.hot : CRM_CACHE_LIFE.warm);
  cacheTag(
    CRM_CACHE_TAGS.dashboard,
    workspace === "pipeline"
      ? CRM_CACHE_TAGS.pipeline
      : workspace === "settlement"
        ? CRM_CACHE_TAGS.settlement
        : CRM_CACHE_TAGS.assets,
  );

  return getDashboardData(workspace ? { workspace } : {});
}

/**
 * Cached compact desktop home snapshot. This deliberately excludes editable
 * campaign payloads so the home screen remains a fast cross-workspace summary.
 */
export async function getCachedDesktopDashboardData() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.hot);
  cacheTag(
    CRM_CACHE_TAGS.dashboard,
    CRM_CACHE_TAGS.pipeline,
    CRM_CACHE_TAGS.settlement,
    CRM_CACHE_TAGS.outreach,
    CRM_CACHE_TAGS.revenueGoals,
  );

  return getDesktopDashboardData();
}

/**
 * Cached settlement-pending snapshot for the mobile home settlement card.
 */
export async function getCachedMobileSettlementCampaigns() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.hot);
  // 홈 정산 대기 카드·대기 목록 시트 전용 경량 스냅샷(2026-07-15, #149 리뷰 후속) —
  // 기존 getCachedDashboardData("pipeline") kitchen-sink 소비를 대체한다. pipeline
  // (캠페인 상태 전이·쓰기)과 settlement(정산 크론·주문 동기화) 태그가 즉시 깨준다.
  // dashboard 태그는 의도적으로 제외(자산·아웃리치·목표 등 무관 쓰기의 재생성 fan-in
  // 차단) — 딜명/셀러명 rename은 hot 재검증 창(≤5분)에 수렴한다.
  cacheTag(CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement);

  return getMobileSettlementCampaigns();
}

/**
 * Cached mobile home snapshot focused on cross-workspace briefing.
 */
export async function getCachedMobileTodayData(): Promise<DashboardData> {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.hot);
  cacheTag(CRM_CACHE_TAGS.dashboard, CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement);

  const prisma = getPrisma();
  const now = new Date();
  const [
    campaigns,
    assets,
    googleDrive,
    overdueReminders,
    overdueSettlements,
    salesTasks,
  ] = await Promise.all([
    prisma.salesCampaign.findMany({
      where: {
        status: {
          in: [
            "PROPOSAL",
            "PREPARATION",
            "ACTIVE",
            "CLOSED",
            "SETTLEMENT_WAIT",
            "SETTLEMENT_IN_PROGRESS",
          ] as CampaignStatus[],
        },
      },
      include: {
        deal: {
          include: {
            partner: { select: { name: true } },
          },
        },
        seller: {
          select: {
            name: true,
            alias: true,
            snsType: true,
            snsHandle: true,
            // agency include 제거(2026-07-10): 모바일 브리핑 소비 컴포넌트(MobileCalendarHome·
            // MobileSettlementPendingSheet)는 sellerCompany*(계좌·대표자·사업자번호·주소 등
            // agency PII)를 전혀 읽지 않는다(grep 실증). 이 payload는 dashboard 태그로 고빈도
            // 재생성되는 warm 캐시라, PII 저장은 write 유닛 낭비이자 PII-at-rest 리스크였다
            // (localStorage PII 제거 결정과 동일 취지). toCampaignRow는 agency?를 optional
            // 체이닝하므로 미포함 시 sellerCompany* 필드가 null로 채워질 뿐 무해하다.
          },
        },
        group: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 80,
    }),
    prisma.asset.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.storageIntegration.findUnique({
      where: { provider: "GOOGLE_DRIVE" },
    }),
    prisma.salesTask.count({
      where: {
        status: "PROPOSED",
        nextReminderAt: { lt: now },
      },
    }),
    prisma.salesCampaign.count({
      where: {
        status: "SETTLEMENT_WAIT",
        returnPeriodEndDate: { lt: now },
      },
    }),
    prisma.salesTask.findMany({
      where: {
        status: { in: ["PROPOSED", "NEGOTIATION", "TESTING", "PENDING_APPROVAL"] },
      },
      select: {
        id: true,
        deal: { select: { id: true, dealName: true } },
        seller: { select: { name: true, alias: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    }),
  ]);
  const recentAssets = assets.map(toAssetRow);

  return {
    deals: [],
    sellers: [],
    campaigns: campaigns.map((campaign) => toCampaignRow(campaign)),
    apiCallLogs: [] satisfies ApiCallLogRow[],
    assets: recentAssets,
    storage: {
      supabaseLimitBytes: SUPABASE_FREE_STORAGE_LIMIT_BYTES,
      supabaseWarningBytes: SUPABASE_STORAGE_WARNING_BYTES,
      supabaseEstimatedBytes: 0,
      googleDriveConnected: googleDrive?.status === "CONNECTED",
      googleDriveAccount: googleDrive?.accountEmail,
      googleDriveRootFolderId: googleDrive?.rootFolderId,
      recentAssets,
    },
    actionRequiredCounts: {
      overdueReminders,
      overdueSettlements,
    },
    salesTasks: salesTasks.map((task) => ({
      id: task.id,
      dealId: task.deal.id,
      dealName: task.deal.dealName,
      sellerName: task.seller.alias || task.seller.name,
    })),
    dataSource: "database",
  };
}

/**
 * Cached initial partner directory payload.
 */
export async function getCachedPartnersPageData() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.warm);
  // dashboard 태그 제거(2026-07-10 fan-out 축소): 거래처 디렉터리는 파트너 정보 + 딜 수만
  // 보여준다 — 캠페인/자산/아웃리치/수수료/목표/셀러지표 쓰기와 무관. partners·deals 태그로
  // master-data 쓰기(파트너·딜 CRUD)에만 재생성 → 잦은 캠페인 쓰기의 불필요한 재생성 제거.
  cacheTag(CRM_CACHE_TAGS.partners, CRM_CACHE_TAGS.deals);

  const partners = await getPrisma().partner.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      contacts: true,
      referredBy: { select: { name: true } },
      _count: { select: { deals: true } },
    },
  });

  return partners.map((partner) => ({
    id: partner.id,
    name: partner.name,
    type: partner.type as PartnerType,
    status: partner.status ?? null,
    contactInfo: partner.contactInfo ?? null,
    bankAccount: partner.bankAccount ?? null,
    businessNumber: partner.businessNumber ?? null,
    companyStatus: partner.companyStatus ?? null,
    companyRole: partner.companyRole ?? null,
    ceoName: partner.ceoName ?? null,
    address: partner.address ?? null,
    bizSyncedAt: partner.bizSyncedAt?.toISOString() ?? null,
    lastContactAt: partner.lastContactAt?.toISOString() ?? null,
    notes: partner.notes ?? null,
    referredById: partner.referredById ?? null,
    referredByName: partner.referredBy?.name ?? null,
    dealCount: partner._count.deals,
    createdAt: partner.createdAt.toISOString(),
    businessType: partner.businessType ?? null,
    businessItem: partner.businessItem ?? null,
    representativeEmail: partner.representativeEmail ?? null,
    orderTemplateSlug: partner.orderTemplateSlug ?? null,
    orderDisplayName: partner.orderDisplayName ?? null,
    orderEmailDomains: partner.orderEmailDomains ?? null,
    orderFormatAdapter: partner.orderFormatAdapter ?? null,
    orderToEmail: partner.orderToEmail ?? null,
    orderCcEmail: partner.orderCcEmail ?? null,
    orderExcelRules: partner.orderExcelRules ?? null,
    contacts: partner.contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      role: contact.role ?? null,
      email: contact.email ?? null,
      phoneNumber: contact.phoneNumber ?? null,
      notes: contact.notes ?? null,
      lastContactAt: contact.lastContactAt?.toISOString() ?? null,
    })),
  }));
}

/**
 * Cached initial seller directory payload.
 */
export async function getCachedSellersPageData() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.warm);
  // dashboard 태그 제거(2026-07-10): 셀러 디렉터리는 "최근 캠페인 스냅샷"을 보여주므로
  // pipeline은 유지(캠페인 쓰기 반영) — 이건 판단 가치가 있는 모멘텀 정보다. sellers 태그로
  // 셀러 CRUD·지표수집 반영. 수수료/목표 등 무관 쓰기의 sweep만 제거.
  cacheTag(CRM_CACHE_TAGS.sellers, CRM_CACHE_TAGS.pipeline);

  // 단일 진실 원천(loadSellerSummaries) — GET /api/sellers 갱신 경로와 동일 필드 집합 보장.
  return loadSellerSummaries();
}

/**
 * Cached initial deal directory payload.
 */
function getSellerCount(candidateSellers: string | null | undefined): number {
  if (!candidateSellers) return 0;
  return candidateSellers.split(",").map((s) => s.trim()).filter(Boolean).length;
}

export async function getCachedDealsPageData() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.warm);
  // dashboard 태그 제거(2026-07-10): 딜 디렉터리의 캠페인 수(_count.campaigns)는 낮은 판단
  // 가치의 배지라, 캠페인 쓰기마다 목록 전체를 재생성하는 CPU 비용이 이득을 넘는다. deals·
  // partners 태그로 딜/파트너 CRUD에만 즉시 재생성하고, 캠페인 수 배지는 warm 창(≤1h) 또는
  // 다음 master-data 쓰기에 갱신된다(딜 상세를 열면 라이브). 잦으면 pipeline 태그 1줄 추가로 복원.
  cacheTag(CRM_CACHE_TAGS.deals, CRM_CACHE_TAGS.partners);

  const deals = await getPrisma().deal.findMany({
    where: {
      dealType: "MAIN",
    },
    include: {
      partner: { select: { name: true, type: true } },
      _count: { select: { campaigns: true, salesTasks: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  // 리뷰 소스 부재 배지(오너 데이터 경로 ②) — 캐시 재생성 시에만 계산(신규 태그·무효화 없음).
  // 링크 입력·크론 수집 반영은 warm(≤1h) 창에 수렴 — 일 1회 크론이 만드는 신호라 충분하다.
  const reviewLinkGaps = await findDealsNeedingReviewLink(deals.map((d) => d.id));

  return deals.map((deal) => ({
    id: deal.id,
    dealName: deal.dealName,
    brandName: deal.brandName ?? null,
    partnerName: deal.partner?.name ?? "거래처 없음",
    partnerId: deal.partnerId ?? "",
    costPrice: Number(deal.costPrice.toString()),
    sellingPrice: Number(deal.sellingPrice.toString()),
    listPrice: deal.listPrice != null ? Number(deal.listPrice.toString()) : null,
    floorPrice: deal.floorPrice != null ? Number(deal.floorPrice.toString()) : null,
    discountRate: deal.discountRate != null ? Number(deal.discountRate.toString()) : null,
    totalCommissionRate:
      deal.totalCommissionRate != null ? Number(deal.totalCommissionRate.toString()) : null,
    brokerageCommissionRate:
      deal.brokerageCommissionRate != null
        ? Number(deal.brokerageCommissionRate.toString())
        : null,
    sourcingMemo: deal.sourcingMemo ?? null,
    candidateSellers: deal.candidateSellers ?? null,
    sellerCount: getSellerCount(deal.candidateSellers),
    status: deal.status as DealStatus,
    campaignCount: deal._count.campaigns,
    taskCount: deal._count.salesTasks,
    createdAt: deal.createdAt.toISOString(),
    baseMarginPolicy: parseBaseMarginPolicy(deal.baseMarginPolicy),
    needsReviewSourceLink: reviewLinkGaps.has(deal.id),
  }));
}

/**
 * Cached annual P&L report payload.
 */
export async function getCachedPnlReportData(year: number) {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.report);
  // dashboard 태그 제거(2026-07-10): P&L은 완료 캠페인 파생이라 reportsPnl(캠페인 쓰기)만으로
  // 충분. 파트너명 변경 등은 report 티어(1h) 창에 수렴 — 리포트 표면에 허용되는 지연.
  cacheTag(CRM_CACHE_TAGS.reportsPnl);

  const campaigns = await getPrisma().salesCampaign.findMany({
    where: {
      status: "COMPLETED",
      startDate: {
        gte: new Date(year, 0, 1),
        lt: new Date(year + 1, 0, 1),
      },
    },
    include: {
      deal: {
        select: {
          dealName: true,
          brandName: true,
          partner: { select: { name: true } },
        },
      },
      seller: { select: { name: true, alias: true } },
    },
    orderBy: { startDate: "asc" },
  });

  return buildPnlReportModel(campaigns, year);
}

/**
 * Cached current-year P&L report payload.
 */
export async function getCachedCurrentYearPnlReportData() {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.report);
  // dashboard 태그 제거(2026-07-10): P&L은 완료 캠페인 파생이라 reportsPnl(캠페인 쓰기)만으로
  // 충분. 파트너명 변경 등은 report 티어(1h) 창에 수렴 — 리포트 표면에 허용되는 지연.
  cacheTag(CRM_CACHE_TAGS.reportsPnl);

  const year = new Date().getFullYear();

  return getCachedPnlReportData(year);
}

/**
 * Cached channel fee settings for the admin configuration screen.
 */
export async function getCachedChannelFeeConfig() {
  "use cache";
  // 저변경 설정 — 쓰기(channel-fees PATCH)가 태그를 즉시 깨므로 static(30일)으로 충분
  cacheLife(CRM_CACHE_LIFE.static);
  cacheTag(CRM_CACHE_TAGS.channelFees);

  const channels = await getPrisma().channelFeeConfig.findMany({
    orderBy: { channel: "asc" },
  });

  return channels.map((channel) => ({
    id: channel.id,
    channel: channel.channel,
    label: channel.label,
    feeRate: Number(channel.feeRate),
    paymentRate: Number(channel.paymentRate),
    notes: channel.notes,
  }));
}

/**
 * Cached Meta review inputs, including the rolling evidence window.
 */
export async function getCachedMetaReviewChecklistData() {
  "use cache";
  // 증빙 롤링 30일 창이 하루 단위로만 움직임 — report 티어로 강등(2026-07-10)
  cacheLife(CRM_CACHE_LIFE.report);
  cacheTag(CRM_CACHE_TAGS.dashboard);

  const data = await getDashboardData();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Meta 제출 증빙(최근 30일 Instagram 성공 호출)은 **공유 top-20 창에서 필터하지 않는다.**
  // `getDashboardData` 의 apiCallLog 조회는 provider 무관 `take: 20` 이라, 다른 provider가
  // 상위 20을 점거하면 증빙이 0건으로 보인다 — 이 페이지의 목적(외부 심사 증빙)이 조용히
  // 무너지는 결함이다. NAVER 호출 계측(P7) 도입으로 실제 발생 가능해져 DB에서 좁혀 읽는다.
  const instagramSuccessRows = await getPrisma().apiCallLog.findMany({
    where: {
      provider: { startsWith: "INSTAGRAM" },
      success: true,
      calledAt: { gte: thirtyDaysAgo },
    },
    orderBy: { calledAt: "desc" },
    take: 50,
  });

  return {
    data,
    thirtyDaysAgoStr: thirtyDaysAgo.toISOString().slice(0, 10),
    instagramSuccessLogs: instagramSuccessRows.map<ApiCallLogRow>((log) => ({
      id: log.id,
      provider: log.provider as ApiCallLogRow["provider"],
      permissionScope: log.permissionScope,
      endpoint: log.endpoint,
      statusCode: log.statusCode,
      success: log.success,
      calledAt: log.calledAt.toISOString(),
      errorMessage: log.errorMessage,
    })),
  };
}

/**
 * Cached helper to determine the default settlement month.
 * Returns current month if there are campaigns, otherwise previous month.
 */
export async function getCachedDefaultSettlementMonth(): Promise<string> {
  "use cache";
  // 출력이 월 단위로만 바뀜(월 전환·정산 상태 변화 시 태그가 깨줌) — hot일 이유 없음(2026-07-10)
  cacheLife(CRM_CACHE_LIFE.report);
  // dashboard 태그 제거(2026-07-10): 출력은 월 단위 정산 상태 파생이라 settlement만으로 충분.
  cacheTag(CRM_CACHE_TAGS.settlement);
  
  const { getCurrentMonth, getMonthDateRange, getPreviousMonth } = await import("@/lib/settlement-report");
  
  const currentMonth = getCurrentMonth();
  const range = getMonthDateRange(currentMonth);
  const prisma = getPrisma();
  
  const count = await prisma.salesCampaign.count({
    where: {
      status: { in: ["SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS", "COMPLETED"] },
      endDate: {
        gte: range.firstDay,
        lte: range.lastDay,
      },
    },
  });
  
  if (count > 0) {
    return currentMonth;
  }
  return getPreviousMonth(currentMonth);
}
