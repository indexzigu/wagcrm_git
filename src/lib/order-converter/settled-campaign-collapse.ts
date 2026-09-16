// 주문관리 목록에서 **정산까지 끝난 캠페인을 접는** 판정·요약 SSOT(순수 함수 — prisma·fs 없음).
//
// 왜 필요한가(오너 요청 2026-09-16): 주문관리를 열면 끝난 캠페인까지 전부 카드로 그려진다.
// 마감 캠페인은 이미 재계산을 하지 않고 캐시값만 쓰므로(`campaigns-handler` 의 `!camp.isActive`
// 분기) 비용은 계산이 아니라 **내려받는 페이로드와 그리는 카드 수**다 — 실측상 마감 6건의
// 캐시 블롭이 60.2KB 이고 그중 정산종료 4건이 34.1KB 다.
//
// ⚠️ **접기는 `campaigns-handler.GET`(HTTP 응답)에서만 한다 — `fetchAndSyncCampaigns` 안에서
// 하지 말 것.** 그 함수는 주문관리 전용이 아니라 **셀러 포털 리포트·성과 카드가 직접 호출**한다
// (`seller-portal-report.tsx` · `seller-performance-card.tsx` 가 `await fetchAndSyncCampaigns(false)`
// 후 `res.json()`). 공유 함수 안에서 필드를 덜어내면 셀러 화면에서 그 캠페인이 조용히 사라진다 —
// select 축소가 포털을 빈 화면으로 만든 #137 과 같은 형태다. 계약 테스트가 이 경계를 고정한다.

/**
 * **정산까지 종결된** 회차 상태.
 *
 * ⛔ `isSalesCampaignLocked`(정산 락)를 재사용하지 말 것 — 이름이 비슷하고 목록이 겹쳐 보이지만
 * 그쪽은 `SETTLEMENT_IN_PROGRESS` 를 **포함**한다(조회창 계산에서 확정 회차를 빼는 용도, #77).
 * 여기서 정산중을 접으면 **아직 돈이 오가는 중인 캠페인이 화면에서 사라진다** — 오너가 접는
 * 범위를 정하며 정산중은 눈에 두기로 명시 확정했다(2026-09-16). 두 질문은 답이 다르므로 목록도
 * 따로 둔다.
 */
export const SETTLED_ROUND_STATUSES = ['COMPLETED', 'DROPPED'] as const;

/** 이 회차가 정산까지 끝났는가. 대소문자·공백은 무시한다(상태는 자유 문자열 컬럼이다). */
export function isSettledRoundStatus(status: string | null | undefined): boolean {
  if (status == null) return false;
  return (SETTLED_ROUND_STATUSES as readonly string[]).includes(status.trim().toUpperCase());
}

export interface CollapsibleCampaign {
  isActive?: boolean | null;
  salesCampaigns?: Array<{ status?: string | null }> | null;
}

/**
 * 이 주문캠페인을 접어도 되는가 — **판매가 마감됐고 연결된 회차가 전부 정산까지 끝났을 때**만.
 *
 * 연결된 회차가 **하나도 없으면 접지 않는다**: 그 상태는 "정산이 끝났다"가 아니라 "판매관리와
 * 아직 연결되지 않았다"이고, 둘을 같게 다루면 연결이 안 된 캠페인이 조용히 목록에서 밀려난다
 * (이 레포에서 반복된 「모름을 0으로 읽는」 실패 계열). 같은 이유로 `status` 가 비어 있는 회차가
 * 하나라도 있으면 접지 않는다 — `isSettledRoundStatus(null)` 이 false 라 자연히 그렇게 된다.
 */
export function isSettledClosedCampaign(camp: CollapsibleCampaign): boolean {
  if (camp.isActive !== false) return false;
  const rounds = camp.salesCampaigns ?? [];
  if (rounds.length === 0) return false;
  return rounds.every((sc) => isSettledRoundStatus(sc?.status));
}

/**
 * 접힌 줄이 쓰는 필드. **여기 없는 것은 초기 로딩에서 내려가지 않는다** — 그게 이 기능의 실체다.
 *
 * 고른 기준: 줄 하나에 이미 보이는 것(이름·기간·최종 실적)과, 펼치기 버튼이 동작하는 데 필요한
 * 식별자뿐이다. 무거운 것(일자별 집계 `dailyStats` · `insights` · `mappings` · `tasks` ·
 * 주문 목록 4종 · `salesCampaigns`)은 전부 뺀다.
 *
 * ⚠️ 여기 담는 수치는 **마감 시점에 이미 확정돼 저장된 값**이라 접힌 상태에서 보여줘도 정직하다.
 * 반대로 아직 안 가져온 것(그래프·주문 목록)은 접힌 줄에서 0 이나 빈 값으로 **표시하지 않는다** —
 * "안 가져왔다"와 "0건이다"는 다른 말이고, 그 둘을 섞는 것이 P7 이 금지하는 형태다.
 */
export const COLLAPSED_CAMPAIGN_FIELDS = [
  'id',
  'name',
  'category',
  'template',
  'orderProvider',
  'isActive',
  'productStatus',
  'salePeriod',
  'periodLabel',
  'startDate',
  'endDate',
  'createdAt',
  'totalOrders',
  'distinctOrderCount',
  'totalQuantity',
  'totalRevenue',
] as const;

export interface CollapsedCampaignSummary {
  /** 이 줄이 접힌 상태임을 화면이 알아보는 표식. 펼치면 서버에서 전체를 받아 교체한다. */
  isCollapsed: true;
  [key: string]: unknown;
}

/** 캠페인 하나를 접힌 줄이 쓸 요약으로 줄인다. */
export function toCollapsedCampaignSummary(camp: Record<string, unknown>): CollapsedCampaignSummary {
  const summary: Record<string, unknown> = {};
  for (const field of COLLAPSED_CAMPAIGN_FIELDS) {
    if (field in camp) summary[field] = camp[field];
  }
  return { ...summary, isCollapsed: true } as CollapsedCampaignSummary;
}

/**
 * 목록에서 정산종료 캠페인만 요약으로 바꾼다. **순서는 바꾸지 않는다** — 정렬은 호출부(목록
 * 응답)의 계약이고, 여기서 접힌 것을 아래로 몰면 화면의 시간순 배열이 조용히 깨진다.
 */
export function collapseSettledCampaigns<T extends Record<string, unknown> & CollapsibleCampaign>(
  campaigns: T[],
): Array<T | CollapsedCampaignSummary> {
  return campaigns.map((camp) =>
    isSettledClosedCampaign(camp) ? toCollapsedCampaignSummary(camp) : camp,
  );
}
