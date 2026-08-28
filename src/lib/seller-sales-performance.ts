// 셀러 실판매 성과 요약 — T3 분석 리포트 "실측 성과" 카드의 판정 SSOT (순수·client-safe).
//
// 왜 존재하나(2026-08-08, 오너 승인 1층 ②): AI 점수는 SNS 반응의 **대리 지표**인데, 이
// CRM 은 관리대상 셀러의 실제 전환(캠페인 실매출)을 이미 갖고 있다. 그 실측을 AI 점수
// 옆에 병기해 "이 셀러가 실제로 파는가"를 화면 한 번에 판단하게 한다.
//
// 개수 접기는 countEffectiveCampaigns(CG-1 SSOT)에 위임한다 — 그룹은 실캠페인 1개를
// 딜별 N행으로 분할한 것이라 행 단위로 세면 그룹 셀러의 "캠페인당 평균"만 조직적으로
// 낮아진다. 매출 합은 접기와 무관하다(행 합 = 실캠페인 합).
//
// ⚠️ 평균의 분모는 "실매출이 잡힌 유효 캠페인"이다 — 미입력(null·0) 캠페인을 분모에
// 넣으면 평균이 데이터 입력률에 출렁인다("미입력을 낙제로" 결함의 평균 버전). 분모가
// 0이면 평균은 null = 판정 불가이지 0원이 아니다.

import { countEffectiveCampaigns } from './campaign-group-count';

export interface SellerSalesRow {
  /** Prisma Decimal 이 그대로 들어올 수 있어 number 로 강제 변환한다 */
  actualSales: number | { toString(): string } | null;
  groupId: string | null;
}

export interface SellerSalesPerformance {
  /** 유효 캠페인 수 (그룹 = 1건) */
  effectiveCount: number;
  /** 실매출(>0)이 잡힌 유효 캠페인 수 */
  effectiveWithSales: number;
  /** 실매출 합 (원) */
  totalSales: number;
  /** 총매출 ÷ effectiveWithSales — 분모 0 이면 null(판정 불가) */
  avgSalesPerCampaign: number | null;
}

function toSales(v: SellerSalesRow['actualSales']): number {
  if (v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function summarizeSellerSalesPerformance(
  rows: readonly SellerSalesRow[],
): SellerSalesPerformance {
  const effectiveCount = countEffectiveCampaigns(rows);

  let totalSales = 0;
  const groupsWithSales = new Set<string>();
  let ungroupedWithSales = 0;
  for (const row of rows) {
    const sales = toSales(row.actualSales);
    totalSales += sales;
    if (sales > 0) {
      if (row.groupId != null) groupsWithSales.add(row.groupId);
      else ungroupedWithSales += 1;
    }
  }
  const effectiveWithSales = groupsWithSales.size + ungroupedWithSales;

  return {
    effectiveCount,
    effectiveWithSales,
    totalSales,
    avgSalesPerCampaign: effectiveWithSales > 0 ? Math.round(totalSales / effectiveWithSales) : null,
  };
}
