/**
 * 정산 목록 선택 합산 SSOT — 정산 테이블에서 캠페인을 여러 건 선택했을 때
 * 플로팅 선택 바에 보여주는 거래액·영업수익·판매대행비·영업이익 합계.
 * 미입력(null)은 0 으로 취급한다 — 셀은 "-" 로 비어 보이지만 합산에서는
 * 기여분이 없다는 뜻이지 합산 불가가 아니다.
 */

export interface SettlementSelectionSummaryInput {
  actualSales?: number | null;
  settlementSales?: number | null;
  sellerExpense?: number | null;
  operatingProfit?: number | null;
}

export interface SettlementSelectionSummary {
  actualSales: number;
  settlementSales: number;
  sellerExpense: number;
  operatingProfit: number;
}

export function sumSettlementSelection(
  campaigns: readonly SettlementSelectionSummaryInput[],
): SettlementSelectionSummary {
  return campaigns.reduce<SettlementSelectionSummary>(
    (acc, campaign) => ({
      actualSales: acc.actualSales + (campaign.actualSales ?? 0),
      settlementSales: acc.settlementSales + (campaign.settlementSales ?? 0),
      sellerExpense: acc.sellerExpense + (campaign.sellerExpense ?? 0),
      operatingProfit: acc.operatingProfit + (campaign.operatingProfit ?? 0),
    }),
    { actualSales: 0, settlementSales: 0, sellerExpense: 0, operatingProfit: 0 },
  );
}

/**
 * 「정산 완료」 표의 한 행을 합산 입력으로 옮긴다.
 *
 * ⚠️ 완료 표는 진행 중 표와 **금액 출처가 다르다** — 영업수익·판매대행비를
 * 캠페인 컬럼이 아니라 정산 리포트 파생값(`totalMarginAmount`·`sellerPayoutAmount`)
 * 으로 렌더한다. 그 파생값은 저장 컬럼이 있으면 그대로 쓰고 **비어 있을 때만 요율로
 * 폴백**하므로(`settlement-report.ts`), 캠페인 컬럼을 그대로 합산하면 폴백으로 화면에
 * 숫자가 떠 있는 건이 합계에서는 0으로 세어진다 — 라벨과 실제 합산이 어긋난다
 * (styleseed metric-integrity). 그래서 합산도 **그 표가 실제로 보여주는 값**을 쓴다.
 * ⛔ 진행 중 표에 이 매핑을 쓰지 말 것: 그쪽은 폴백 없이 컬럼을 그대로 렌더하므로
 * (컬럼이 비면 "-") 리포트 파생값을 넣으면 반대 방향으로 어긋난다.
 */
export function toCompletedSelectionInput(
  campaign: {
    actualSales?: number | null;
    operatingProfit?: number | null;
  },
  reportCampaign?: {
    totalMarginAmount?: number | null;
    sellerPayoutAmount?: number | null;
  } | null,
): SettlementSelectionSummaryInput {
  return {
    actualSales: campaign.actualSales ?? null,
    settlementSales: reportCampaign?.totalMarginAmount ?? null,
    sellerExpense: reportCampaign?.sellerPayoutAmount ?? null,
    operatingProfit: campaign.operatingProfit ?? null,
  };
}
