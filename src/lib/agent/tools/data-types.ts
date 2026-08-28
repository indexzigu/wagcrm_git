// 5개 READ 도구의 Data 타입(+구성 타입) 전용 모듈 (청사진 §2-1/§3-1).
//
// ⚠️ 런타임 import 0 — 이 파일은 타입 선언만 포함한다. 값 import를 한 줄이라도
// 추가하면 클라이언트 번들에 prisma/service 런타임이 딸려 들어가는 위험 구조가
// 부활한다(plan-critic #1). 타입만 필요하면 반드시 `import type`을 쓰고, 값은
// 절대 import하지 않는다.
//
// tool-result-views.tsx(클라이언트 리치 렌더)는 이 모듈에서만 타입을 가져온다.
// 각 tool 파일(settlement-report.ts 등)은 여기서 `import type` + `export type`으로
// re-export해 기존 import 경로를 그대로 유지한다(런타임 코드는 각 tool 파일에 그대로 남음).

// SettlementStateLabel은 런타임-프리 상태기계 모듈(settlement-status.ts)에서 그대로 가져와
// re-export한다 — settlement-report.ts가 `export type { SettlementStateLabel }`로 기존
// 소비처(예: tool-result-views.tsx)에 노출해야 하므로 이 모듈에서도 이름을 통과시킨다.
import type { SettlementStateLabel } from "@/lib/settlement-status";
export type { SettlementStateLabel };

// ---- get_settlement_report ----

export type SettlementCampaignWithState = {
  id: string;
  dealName: string;
  brandName: string | null;
  sellerName: string;
  actualSales: number;
  sellerPayoutAmount: number;
  netMarginAmount: number;
  state: SettlementStateLabel;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  depositReceivedAt: string | null;
  payoutCompletedAt: string | null;
};

export type GetSettlementReportData = {
  period: string;
  summary: {
    totalRevenue: number;
    totalMargin: number;
    totalSellerPayouts: number;
    campaignCount: number;
  };
  /** 예정/확정/지급 상태 라벨이 붙은 캠페인 목록 (screen 수치와 일치, 청사진 3중 방어 ①) */
  campaigns: SettlementCampaignWithState[];
  stateCounts: Record<SettlementStateLabel, number>;
};

// ---- search_deals ----

export type DealSearchResultItem = {
  id: string;
  dealName: string;
  brandName: string | null;
  status: string;
  sellingPrice: number;
  costPrice: number;
  partnerName: string | null;
  updatedAt: string;
};

export type SearchDealsData = {
  items: DealSearchResultItem[];
  count: number;
  truncated: boolean;
};

// ---- get_pipeline_status ----

export type PipelineStatusCount = {
  status: string;
  count: number;
};

export type PipelineCampaignSummary = {
  id: string;
  dealName: string;
  sellerName: string;
  status: string;
  startDate: string;
  endDate: string;
};

export type GetPipelineStatusData = {
  statusCounts: PipelineStatusCount[];
  totalCount: number;
  /** status 파라미터가 지정된 경우에만 채워지는 상세 목록 (최대 20건) */
  campaigns: PipelineCampaignSummary[];
};

// ---- get_campaign_financials ----

export type GetCampaignFinancialsData = {
  campaignId: string;
  dealName: string;
  sellerName: string;
  status: string;
  actualSales: number;
  /** 파생 계산 결과 — settlementService의 정산 확정치와는 별개 (계산값이며 확정 아님, 3중 방어) */
  derived: {
    settlementSales: number;
    sellerExpense: number;
    taxExpense: number;
    operatingProfit: number;
  };
  /** 입금/지급 실제 확인 여부 — derived 계산값과 혼동 금지 */
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
};

// ---- get_order_snapshot ----

export type OrderSnapshotDay = {
  snapshotDate: string;
  ordersCount: number;
  newOrdersCount: number;
  preparingCount: number;
  deliveringCount: number;
  lastCallTime: string;
};

export type GetOrderSnapshotData = {
  days: OrderSnapshotDay[];
  totals: {
    ordersCount: number;
    newOrdersCount: number;
    preparingCount: number;
    deliveringCount: number;
  };
};
