/**
 * 한 주문캠페인에 **서로 다른 셀러**가 붙었는지 판정하는 원시함수 — 순수·의존성 0.
 *
 * ## 왜 중립 모듈인가
 *
 * 같은 불변식을 **세 곳**이 본다:
 *  - 셀러 대면 표면(`seller-portal.ts`) — 걸리면 **표시 제외**(최후 방어선)
 *  - 퍼지 자동매핑(`order-converter/mapping-service.ts`) — 걸리면 **전체 거부**(쓰기 차단)
 *  - 수동 매핑 저장(`order-converter/api/campaigns/[id]`) — 걸리면 **400**(쓰기 차단)
 *
 * 셋이 각자 `new Set(...).size > 1` 을 손으로 쓰면 갈라진다(이 레포가 반복해서 밟은 함정 —
 * `deal-claim-context` · `product-order-range-type` · 크론 인증 사본 18개). 판정은 한 곳이다.
 * 포털이 `src/lib` 루트에 두는 이유는 order-converter 가 포털 모듈을 import 하는 역방향
 * 의존을 만들지 않기 위해서다.
 *
 * ## 규칙의 근거(정본)
 *
 * **왜 이 상태가 위험한가**와 **왜 정상 운영에 존재하지 않는가**(오너 확정 2026-08-05)는
 * `src/lib/seller-portal.ts` 상단 주석이 정본이다. 요지만 옮기면:
 * 포털은 `salesCampaigns` 중 하나라도 자기 셀러면 그 캠페인을 "내 것"으로 보고 **캠페인 전체
 * 집계**를 렌더한다. 그래서 두 셀러가 한 주문캠페인에 붙으면 A 화면에 A+B 합산이 A 의 실적으로
 * 나간다(P0 「Seller-Facing Data Exposure」 위반).
 *
 * ⛔ 판정을 `productId` 로 바꾸지 말 것 — 주문 귀속은 productId 가 아니라 상품명·옵션명 문자열의
 * 양방향 부분일치(`order-converter/campaign-orders.ts`)로 이뤄진다. 판정은 실제로 합산이 흘러드는
 * 조건 그 자체, 즉 **링크 관계의 distinct sellerId** 를 본다.
 */

/**
 * 서로 다른 셀러 수. 빈 값·null 은 귀속 불가라 세지 않는다 —
 * ⚠️ 미입력을 "또 하나의 셀러"로 세면 정상 캠페인이 오탐으로 막힌다
 * (이 레포의 "미입력을 낙제로" 부류 결함과 같은 함정).
 */
export function countDistinctSellerIds(
  sellerIds: readonly (string | null | undefined)[],
): number {
  const ids = new Set<string>();
  for (const raw of sellerIds) {
    const id = raw == null ? "" : String(raw);
    if (id) ids.add(id);
  }
  return ids.size;
}

/** 셀러 단일성이 깨졌는가 = 집계가 셀러별로 갈리지 않는 상태. */
export function isCrossSellerSet(
  sellerIds: readonly (string | null | undefined)[],
): boolean {
  return countDistinctSellerIds(sellerIds) > 1;
}

/**
 * 쓰기 차단 시 운영자에게 보여줄 문구 — 자동매핑(서버 로그)과 수동 저장(400 응답)이 공유한다.
 * ⚠️ 셀러 실명·캠페인명·실측 수치를 넣지 않는다(P0, 레포 public). 식별자만 호출부가 덧붙인다.
 */
export const CROSS_SELLER_REJECT_MESSAGE =
  "한 주문캠페인에 서로 다른 셀러의 판매캠페인을 연결할 수 없습니다. " +
  "주문캠페인은 셀러·회차마다 새로 만드는 것이 운영 규약이며, 섞이면 셀러 화면에 " +
  "다른 셀러의 매출이 합산돼 나갑니다. 딜 연결을 한 셀러로 정리하거나 주문캠페인을 나누세요.";

/** 응답 코드 판별용 마커 — `instanceof` 는 번들 경계에서 신뢰할 수 없어 문자열 코드로 가른다. */
export const CROSS_SELLER_REJECTED_CODE = "CROSS_SELLER_REJECTED";

/**
 * 수동 매핑 저장이 셀러 단일성을 깨뜨릴 때 던진다. 트랜잭션 안에서 던져 **저장 전체를 롤백**
 * 시키는 것이 의도다 — 매핑만 빼고 나머지를 저장하면 운영자는 "저장됐다"고 믿는데 실제로는
 * 의도한 연결이 안 붙은 상태가 된다(조용한 부분 성공 금지).
 */
export class CrossSellerRejectedError extends Error {
  readonly code = CROSS_SELLER_REJECTED_CODE;
  constructor(message: string = CROSS_SELLER_REJECT_MESSAGE) {
    super(message);
    this.name = "CrossSellerRejectedError";
  }
}
