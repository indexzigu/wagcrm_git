/**
 * 주문관리 카드 1행의 주의 배지 순위(T-175).
 *
 * 주의 배지는 **소수일 때만** 눈에 띈다. 한 캠페인에 셋이 한 줄로 겹치면 전부 같은 무게로
 * 읽혀 정작 급한 것을 지나치게 된다(두 번의 리뷰가 같은 지적). 그래서 카드는 **맨 앞 1개만**
 * 그대로 보여주고 나머지는 「+N」 칩 뒤로 접는다 — 이 함수가 그 「맨 앞」을 정한다.
 *
 * 순위 기준은 **지금 손을 대면 무엇이 풀리는가**다:
 * 1. `store-drift` — 스토어 판매기간이 화면·집계 기간과 다르다. 한 번 눌러 맞추는 액션이 있고,
 *    스토어가 기간을 늘린 경우 **아래 `post-period` 의 원인**이기도 하다(맞추면 그 주문들이
 *    창 안으로 들어온다). 원인을 결과보다 앞에 둔다.
 * 2. `post-period` — 판매기간 뒤에 들어온 실제 주문이 발주서엔 실리지만 주문확인 집계엔 빠진다.
 * 3. `frozen-drift` — 정산 확정으로 기간 변경이 반영되지 않는다. 알림이지 지금 할 일이 없다. 그래서 지금 집계에서
 *    빠지고 있는 실제 주문(`post-period`)보다 뒤다.
 * 4. `period-mismatch` — 판매캠페인 기간이 서로 달라 합성 창을 쓴다. 역시 알림.
 *
 * `store-drift` 와 `frozen-drift` 는 서버에서 배타적이다(창이 얼면 드리프트를 내지 않는다 —
 * `resolveStorePeriodDrift`) — 그래서 한 카드의 최대치는 3개다.
 */
export type CampaignCardCaution = 'store-drift' | 'post-period' | 'frozen-drift' | 'period-mismatch';

export type CampaignCardCautionInput = {
  isActive?: boolean | null;
  storePeriodDrift?: unknown;
  postPeriodOrderCount?: number | null;
  periodFrozenDrift?: boolean | null;
  periodMismatch?: boolean | null;
};

/** 켜진 주의 배지를 급한 순으로 돌려준다. 첫 원소가 카드에 펼쳐 보일 1개다. */
export function rankCampaignCardCautions(camp: CampaignCardCautionInput): CampaignCardCaution[] {
  const ranked: CampaignCardCaution[] = [];
  if (camp.storePeriodDrift) ranked.push('store-drift');
  // 마감 카드는 발주가 끝났으므로 이 신호를 내지 않는다(종전 렌더 조건 그대로).
  if (camp.isActive !== false && (camp.postPeriodOrderCount ?? 0) > 0) ranked.push('post-period');
  if (camp.periodFrozenDrift) ranked.push('frozen-drift');
  if (camp.periodMismatch) ranked.push('period-mismatch');
  return ranked;
}
