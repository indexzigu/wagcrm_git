// 주문관리 파이프라인 상태(신규/배송대기/배송중/배송완료) 판정을 한 곳으로 모은 순수 로직.
//
// 배경(2026-07-08): "배송대기"의 의미가 원래 의도(발주요청 이메일 발송됨)와 달리 네이버
// productOrderStatus === 'DISPATCH_WAIT'(=우리가 네이버에 송장 안 올림)로 배선돼 있었다.
// 사용자 의도는 상품주문 1건 단위로:
//   주문확인(발주확인) → [발주요청 메일 발송] → 배송대기 → [송장등록] → 배송중
// 이라, "배송대기 = 발주요청됨(우리 자체 액션)"으로 재정의한다. 발주요청 여부는
// OrderFulfillmentState.poRequestedAt(상품주문번호 단위)로 영속되며, 이 헬퍼가 네이버 상태와
// 우리 액션을 합성해 최종 표시 버킷을 도출한다.
//
// 이 모듈은 순수 함수만 담는다(fetch·DB 없음) — campaigns/route.ts, [id]/route.ts 등 여러
// 집계 지점의 판정이 어긋나지 않도록 단일 진실로 고립시키고 유닛테스트 대상으로 삼는다.

import { INVALID_ORDER_STATUSES } from './group-orders';

export type OrderPipelineBucket =
  | 'newBefore' // 신규주문 · 발주확인 전 (PAYED & placeOrderStatus NOT_YET)
  | 'newAfter' // 주문확인(후) · 발주확인됨 but 발주요청 아직 (PAYED&OK / PRODUCT_ORDERED / DISPATCH_WAIT)
  | 'pending' // 배송대기 · 발주요청 메일 발송됨, 아직 미발송(네이버 배송중 전)
  | 'shipping' // 배송중 · 송장등록 완료 (네이버 DELIVERING)
  | 'completed' // 배송완료/구매확정 (DELIVERED / PURCHASE_DECIDED)
  | 'other'; // 취소·반품·교환·결제대기 등 파이프라인 집계 대상 아님

/**
 * 상품주문 1건의 파이프라인 표시 버킷을 도출한다.
 *
 * 우선순위(위에서부터):
 *  1. 무효 상태(취소·반품·교환·결제대기) → other  ← 발주요청 흔적이 있어도 파이프라인 제외
 *  2. 배송완료/구매확정  → completed
 *  3. 네이버 배송중(DELIVERING/DISPATCHED*) → shipping
 *  4. 발주요청됨(poRequested) → pending (배송대기)  ← 네이버 상태보다 우리 액션이 우선
 *  5. PAYED & 발주확인 전(NOT_YET) → newBefore
 *  6. 발주확인됨(PAYED&OK / PRODUCT_ORDERED / DISPATCH_WAIT) → newAfter
 *  7. 그 외 → other
 *
 * (*) DISPATCHED는 실제로는 productOrderStatus가 아니라 변경유형 코드라 이 자리에 거의 오지
 *     않지만, 만에 하나 온다면 "이미 발송됨"이므로 shipping으로 접는다(기존 동작 보존).
 *
 * 무효 상태를 poRequested보다 먼저 거르는 이유: 발주요청 후 고객이 취소한 건을 배송대기에
 * 붙잡아두면 안 된다. poRequested가 true여도 이미 배송중/배송완료면 그 최신 상태가 이긴다 —
 * 발주요청 후 송장까지 등록된 정상 진행을 배송대기에 남기지 않기 위함이다.
 */
export function deriveOrderPipelineBucket(
  productOrderStatus: string | null | undefined,
  placeOrderStatus: string | null | undefined,
  poRequested: boolean,
): OrderPipelineBucket {
  const status = productOrderStatus || '';

  if (INVALID_ORDER_STATUSES.includes(status)) return 'other';
  if (status === 'DELIVERED' || status === 'PURCHASE_DECIDED') return 'completed';
  if (status === 'DISPATCHED' || status === 'DELIVERING') return 'shipping';
  if (poRequested) return 'pending';
  if (status === 'PAYED') {
    return !placeOrderStatus || placeOrderStatus === 'NOT_YET' ? 'newBefore' : 'newAfter';
  }
  if (status === 'PRODUCT_ORDERED' || status === 'DISPATCH_WAIT') return 'newAfter';
  return 'other';
}
