import type { CampaignRow } from "@/lib/crm-types";
import { resolveCampaignNetMargin } from "@/lib/settlement-report";

/** 판매 관리 요약띠가 읽는 행 — 대시보드가 이미 가진 CampaignRow 의 금액 관련 필드만. */
export type PipelineMoneyRow = Pick<
  CampaignRow,
  | "status"
  | "actualSales"
  | "settlementSales"
  | "sellerExpense"
  | "totalMarginRate"
  | "sellerMarginRate"
  | "sellerFeeBasisOverride"
  | "campaignDeals"
>;

export type PipelineMoneySummary = {
  grossMerchandise: number;
  commissionRevenue: number;
  sellerPayout: number;
  grossProfit: number;
};

/** 요약띠에서 빼는 상태 — 정산 진행 이후·드롭은 「앞으로 들어올 돈」 합계에 넣지 않는다. */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  "DROPPED",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
]);

/**
 * 행별 금액은 저장값(settlementSales·sellerExpense)이 정본이고, 비어 있을 때만
 * `resolveCampaignNetMargin` 의 요율 폴백을 쓴다 — 새 산식을 만들지 않는다(SSOT).
 */
export function summarizePipelineMoney(rows: PipelineMoneyRow[]): PipelineMoneySummary {
  const sum: PipelineMoneySummary = {
    grossMerchandise: 0,
    commissionRevenue: 0,
    sellerPayout: 0,
    grossProfit: 0,
  };
  for (const row of rows) {
    if (EXCLUDED_STATUSES.has(row.status)) continue;
    const m = resolveCampaignNetMargin(row);
    sum.grossMerchandise += row.actualSales || 0;
    sum.commissionRevenue += m.totalMarginAmount;
    sum.sellerPayout += m.sellerPayoutAmount;
    sum.grossProfit += m.netMarginAmount;
  }
  // 폴백 행은 소수 원이 나올 수 있다 — 합계는 한 번만 반올림해 화면에 소수가 안 보이게 한다.
  return {
    grossMerchandise: Math.round(sum.grossMerchandise),
    commissionRevenue: Math.round(sum.commissionRevenue),
    sellerPayout: Math.round(sum.sellerPayout),
    grossProfit: Math.round(sum.grossProfit),
  };
}
