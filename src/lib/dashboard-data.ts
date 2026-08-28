import * as Sentry from "@sentry/nextjs";
import { getPrisma } from "./prisma";
import { mockDashboardData } from "./mock-data";
import { getWorkspaceStatuses } from "./campaign-checklist";
import { parseBaseMarginPolicy } from "./base-margin-policy";
import type {
  ApiProvider,
  ApiCallLogRow,
  CampaignStatus,
  DashboardData,
  DealSummary,
  DealStatus,
  PartnerType,
  SellerSummary,
  SnsType,
} from "./crm-types";
import {
  SUPABASE_FREE_STORAGE_LIMIT_BYTES,
  SUPABASE_STORAGE_WARNING_BYTES,
} from "./asset-storage";
import { estimateSupabaseAssetBytes, toAssetRow } from "./assets";
import { numberFromDecimal, toCampaignRow } from "./campaign-row";
import {
  buildViolatedCampaignSummaries,
  resolveLatestVerdictByDeal,
} from "./price-monitor/campaign-price-violation";

type DashboardDataOptions = {
  workspace?: "pipeline" | "settlement";
  /**
   * "mobileLite" = 모바일 캠페인 탭(조회 전용) 경량 로드 (2026-07-23).
   *
   * /pipeline 은 요청당 동적 렌더(CRM_DYNAMIC_SURFACES)라 탭 진입마다 이
   * 함수가 통째로 돈다. 모바일 뷰(MobilePipelineView + 조회 상세 시트)는
   * campaigns 행과 actionRequiredCounts 만 소비하고, 마스터데이터를 쓰는
   * 표면(생성 시트·콤보 다이얼로그·SidePanel)은 모바일에서 열리는 진입점이
   * 없다 — 닫힌 Radix 시트는 content 를 언마운트하므로 빈 배열도 읽지 않는다.
   * 따라서 deals·sellers(+히스토리 12건씩)·apiCallLogs·assets·storage·
   * salesTasks·partners 7종 조회와 estimateSupabaseAssetBytes 를 건너뛰어
   * Vercel 함수 시간과 Supabase egress 를 줄인다. 반환 형태는 DashboardData
   * 그대로(빈값 채움)라 소비측 타입·렌더 경로는 변하지 않는다.
   */
  scope?: "full" | "mobileLite";
};

type DashboardDataSourceMode = "database" | "mock";

function getDashboardDataSourceMode(): DashboardDataSourceMode {
  return process.env.CRM_DATA_SOURCE?.trim().toLowerCase() === "mock"
    ? "mock"
    : "database";
}

function buildMockDashboardData(message: string): DashboardData {
  return JSON.parse(
    JSON.stringify({
      ...mockDashboardData,
      dataSource: "mock",
      dataSourceMessage: message,
    }),
  ) as DashboardData;
}

export async function getDashboardData(
  options: DashboardDataOptions = {},
): Promise<DashboardData> {
  const dataSourceMode = getDashboardDataSourceMode();

  if (dataSourceMode === "mock") {
    return buildMockDashboardData(
      "관리자 설정에 따라 목업 데이터를 표시 중입니다. 실제 DB 데이터로 전환하려면 배포 환경의 데이터 소스 설정을 변경하세요.",
    );
  }

  try {
    const prisma = getPrisma();
    const workspaceStatuses = getWorkspaceStatuses(options.workspace ?? null);
    const campaignStatuses =
      options.workspace === "pipeline" && workspaceStatuses
        ? [...workspaceStatuses, "DROPPED"]
        : workspaceStatuses;
    const lite = options.scope === "mobileLite";
    const [deals, sellers, campaigns, apiCallLogs, assets, googleDrive, overdueReminders, overdueSettlements, salesTasks, partners] = await Promise.all([
      lite ? [] : prisma.deal.findMany({
        where: { dealType: "MAIN" },
        include: { partner: true },
        orderBy: { updatedAt: "desc" },
      }),
      lite ? [] : prisma.seller.findMany({
        include: { histories: { orderBy: { snapshotDate: "asc" }, take: 12 } },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.salesCampaign.findMany({
        where: campaignStatuses
          ? { status: { in: campaignStatuses as CampaignStatus[] } }
          : undefined,
        include: {
          deal: { include: { partner: true } },
          campaignDeals: { include: { deal: true } },
          seller: {
            include: {
              agency: true,
              histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
            },
          },
          activities: {
            orderBy: { createdAt: "desc" },
            take: 12,
          },
          notes: { orderBy: { createdAt: "desc" } },
          checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
          // 정산 화면이 이 페이로드만으로 거래처 정산 총액을 계산한다 — 여기 빠지면
          // 부가 항목(광고비·반품배송비)이 **조용히 빈 배열**로 내려가 첫 화면과 새로고침 후의
          // 금액이 달라진다(목록 API `campaignService.getCampaignsList` 는 이미 싣고 있었다).
          // ⚠️ include 트리는 workspace 로 갈리지 않는다(workspace 는 where 절의 상태 필터에만
          // 걸린다) — 이 관계는 pipeline 페이로드에도 함께 실린다. 행 수가 적고 필드가 작아
          // egress 영향은 이미 같은 방식으로 공유되는 checklistItems 수준이다.
          settlementItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          group: {
            select: {
              _count: { select: { members: true } },
              expectedDepositDate: true,
              depositReceivedAt: true,
              isDepositReceived: true,
              expectedPayoutDate: true,
              payoutCompletedAt: true,
              isPayoutCompleted: true,
              supplierInvoiceIssuedAt: true,
              sellerInvoiceIssuedAt: true,
              accountingCompletedAt: true,
              invoiceInfo: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      }),
      lite ? [] : prisma.apiCallLog.findMany({
        orderBy: { calledAt: "desc" },
        take: 20,
      }),
      lite ? [] : prisma.asset.findMany({
        where: { archivedAt: null },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      lite ? null : prisma.storageIntegration.findUnique({
        where: { provider: "GOOGLE_DRIVE" },
      }),
      prisma.salesTask.count({
        where: {
          status: "PROPOSED",
          nextReminderAt: { lt: new Date() },
        },
      }),
      prisma.salesCampaign.count({
        where: {
          status: "SETTLEMENT_WAIT",
          returnPeriodEndDate: { lt: new Date() },
        },
      }),
      lite ? [] : prisma.salesTask.findMany({
        select: {
          id: true,
          deal: { select: { id: true, dealName: true } },
          seller: { select: { name: true, alias: true } },
        },
      }),
      lite ? [] : prisma.partner.findMany({
        select: {
          id: true,
          name: true,
          type: true,
        },
      }),
    ]);
    const supabaseEstimatedBytes = lite ? 0 : await estimateSupabaseAssetBytes();

    // UX1-C: 판매관리 칸반 카드 최저가 위반 배지 — 이번 응답에 포함된 캠페인들의 딜(메인+하위)
    // id 전체를 모아 단일 findMany로 조회한다(N+1 금지). "최신" 판정은 순수 리듀서
    // (resolveLatestVerdictByDeal)가 snapshotDate 최댓값 기준으로 처리한다.
    const campaignDealIds = new Map<string, string[]>(
      campaigns.map((campaign) => [
        campaign.id,
        [campaign.dealId, ...(campaign.campaignDeals?.map((cd) => cd.dealId) ?? [])],
      ]),
    );
    const allReferencedDealIds = Array.from(
      new Set(Array.from(campaignDealIds.values()).flat()),
    );
    // verdict로 사전 필터하면 안 된다: 딜이 과거에 VIOLATED였다가 이후 OK로 회복돼도
    // VIOLATED 행만 남아 배지가 영구히 지워지지 않는다. dealId별 "최신" 스냅샷 1건만
    // (distinct + snapshotDate desc) 가져와 리듀서가 최신 verdict로 판정하게 한다.
    const violationSnapshotRows = allReferencedDealIds.length
      ? await prisma.priceMonitorSnapshot.findMany({
          where: {
            dealId: { in: allReferencedDealIds },
          },
          select: { dealId: true, snapshotDate: true, verdict: true },
          distinct: ["dealId"],
          orderBy: [{ dealId: "asc" }, { snapshotDate: "desc" }],
        })
      : [];
    const latestVerdictByDeal = resolveLatestVerdictByDeal(
      violationSnapshotRows as { dealId: string; snapshotDate: string; verdict: "OK" | "TIE" | "VIOLATED" | "REVIEW" | "NO_DATA" }[],
    );
    const violationSummaryByCampaignId = buildViolatedCampaignSummaries(
      campaignDealIds,
      latestVerdictByDeal,
    );

    return {
      deals: deals.map<DealSummary>((deal) => ({
        id: deal.id,
        dealName: deal.dealName,
        costPrice: numberFromDecimal(deal.costPrice),
        sellingPrice: numberFromDecimal(deal.sellingPrice),
        status: deal.status as DealStatus,
        partner: deal.partner
          ? {
              id: deal.partner.id,
              name: deal.partner.name,
              type: deal.partner.type as PartnerType,
            }
          : null,
        baseMarginPolicy: parseBaseMarginPolicy(deal.baseMarginPolicy),
      })),
      sellers: sellers.map<SellerSummary>((seller) => ({
        id: seller.id,
        name: seller.name,
        alias: seller.alias,
        snsType: seller.snsType as SnsType,
        snsHandle: seller.snsHandle,
        currentFollowers: seller.currentFollowers,
        currentPostsCount: seller.currentPostsCount ?? null,
        profileBio: seller.profileBio ?? null,
        profilePicUrl: seller.profilePicUrl ?? null,
        profileExternalUrls: seller.profileExternalUrls ?? null,
        category: seller.category,
        histories: seller.histories.map((history) => ({
          snapshotDate: history.snapshotDate.toISOString().slice(0, 10),
          followersCount: history.followersCount,
          postsCount: history.postsCount ?? null,
        })),
      })),
      campaigns: campaigns.map((campaign) => toCampaignRow(campaign, violationSummaryByCampaignId)),
      apiCallLogs: apiCallLogs.map<ApiCallLogRow>((log) => ({
        id: log.id,
        provider: log.provider as ApiProvider,
        permissionScope: log.permissionScope,
        endpoint: log.endpoint,
        statusCode: log.statusCode,
        success: log.success,
        calledAt: log.calledAt.toISOString(),
        errorMessage: log.errorMessage,
      })),
      assets: assets.map(toAssetRow),
      storage: {
        supabaseLimitBytes: SUPABASE_FREE_STORAGE_LIMIT_BYTES,
        supabaseWarningBytes: SUPABASE_STORAGE_WARNING_BYTES,
        supabaseEstimatedBytes,
        googleDriveConnected: googleDrive?.status === "CONNECTED",
        googleDriveAccount: googleDrive?.accountEmail,
        googleDriveRootFolderId: googleDrive?.rootFolderId,
        recentAssets: assets.slice(0, 8).map(toAssetRow),
      },
      actionRequiredCounts: {
        overdueReminders,
        overdueSettlements,
      },
      salesTasks: salesTasks.map((t) => ({
        id: t.id,
        dealId: t.deal.id,
        dealName: t.deal.dealName,
        sellerName: t.seller.alias || t.seller.name,
      })),
      partners: partners.map((partner) => ({
        id: partner.id,
        name: partner.name,
        type: partner.type as PartnerType,
      })),
      dataSource: "database",
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { module: "dashboard-data" },
      extra: {
        fallback: "mock-data",
        dataSourceMode,
      },
    });
    console.error("[wag-crm] Dashboard data fetch failed:", error);

    if (process.env.NODE_ENV !== "production") {
      return buildMockDashboardData(
        "데이터베이스 연결에 실패해 개발 환경에서만 mock 데이터로 표시 중입니다. 잠시 후 새로고침하거나 DB 연결 상태를 확인해주세요.",
      );
    }

    throw error;
  }
}
