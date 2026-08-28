// 매출전송(push) 시 딜별 "반영 vs 미매칭 스킵" 판정 — campaigns-handler의 SSOT 규칙.
//
// 배경: push는 CampaignDeal.quantity/actualSales를 덮어쓴다. 매칭 라인이 아예 없는(매핑 미스매치)
// 딜을 0으로 덮으면 직전값·수동입력이 소실되므로 스킵해야 한다. 반대로 "매핑은 맞았는데 그 사이
// 전부 취소돼 유효 0"이 된 딜은 반드시 0을 반영해야 정산 합계(recalculateSalesCampaignTotals가
// 딜별 actualSales를 재합산)가 낡은 매출을 물지 않는다. 두 경우는 유효주문 수(orders)만으로는
// 구분되지 않는다(둘 다 0) — 취소 라인까지 세는 matchedLines가 구분 신호다.

export type DealPushStat = {
  orders: number;       // 유효주문 라인 수(취소/반품 제외)
  matchedLines: number; // 상태 무관 매칭 라인 수(취소/반품 포함)
};

/**
 * push 경로에서 이 딜을 미매칭으로 스킵(덮어쓰기 생략)할지 판정한다.
 * - matchedLines === 0 → 매핑 미스매치(매칭 라인 전무): true(스킵 + 미매칭 보고).
 * - matchedLines > 0 → 매핑은 맞음: orders가 0(전부 취소)이어도 false(0을 반영해 합계 최신화).
 */
export function shouldSkipDealPush(stat: DealPushStat): boolean {
  return stat.matchedLines === 0;
}
