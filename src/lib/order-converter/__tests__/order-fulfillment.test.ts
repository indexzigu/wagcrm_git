import { describe, it, expect } from 'vitest';
import { deriveOrderPipelineBucket } from '../order-fulfillment';

describe('deriveOrderPipelineBucket', () => {
  it('PAYED & NOT_YET(발주확인 전) → newBefore', () => {
    expect(deriveOrderPipelineBucket('PAYED', 'NOT_YET', false)).toBe('newBefore');
    expect(deriveOrderPipelineBucket('PAYED', null, false)).toBe('newBefore');
    expect(deriveOrderPipelineBucket('PAYED', undefined, false)).toBe('newBefore');
  });

  it('발주확인됨 but 발주요청 전 → newAfter (주문확인 후)', () => {
    expect(deriveOrderPipelineBucket('PAYED', 'OK', false)).toBe('newAfter');
    expect(deriveOrderPipelineBucket('PRODUCT_ORDERED', 'OK', false)).toBe('newAfter');
    // DISPATCH_WAIT은 이제 "배송대기"가 아니라 발주요청 전이면 "주문확인 후"로 분류된다(의미 재정의).
    expect(deriveOrderPipelineBucket('DISPATCH_WAIT', 'OK', false)).toBe('newAfter');
  });

  it('발주요청됨(poRequested) → pending (배송대기)', () => {
    // 발주확인 후 상태 어디에 있든, 발주요청이 나갔고 아직 미발송이면 배송대기.
    expect(deriveOrderPipelineBucket('PAYED', 'OK', true)).toBe('pending');
    expect(deriveOrderPipelineBucket('DISPATCH_WAIT', 'OK', true)).toBe('pending');
    expect(deriveOrderPipelineBucket('PRODUCT_ORDERED', 'OK', true)).toBe('pending');
  });

  it('네이버 배송중(DELIVERING) → shipping (poRequested보다 최신 상태 우선)', () => {
    expect(deriveOrderPipelineBucket('DELIVERING', 'OK', false)).toBe('shipping');
    // 발주요청됐어도 이미 송장등록돼 배송중이면 배송중이 이긴다.
    expect(deriveOrderPipelineBucket('DELIVERING', 'OK', true)).toBe('shipping');
    // DISPATCHED가 만에 하나 상태로 오면 이미 발송이므로 배송중.
    expect(deriveOrderPipelineBucket('DISPATCHED', 'OK', true)).toBe('shipping');
  });

  it('배송완료/구매확정 → completed (가장 우선)', () => {
    expect(deriveOrderPipelineBucket('DELIVERED', 'OK', true)).toBe('completed');
    expect(deriveOrderPipelineBucket('PURCHASE_DECIDED', 'OK', true)).toBe('completed');
  });

  it('취소·반품·교환·결제대기·미결제취소 등은 other (파이프라인 미집계)', () => {
    // 네이버 실제 enum: 결제대기=PAYMENT_WAITING, 미결제취소=CANCELED_BY_NOPAYMENT
    for (const s of ['CANCELED', 'RETURNED', 'EXCHANGED', 'PAYMENT_WAITING', 'CANCELED_BY_NOPAYMENT']) {
      expect(deriveOrderPipelineBucket(s, 'OK', false)).toBe('other');
    }
    // 발주요청 흔적이 있어도 취소/반품이면 배송대기로 오르지 않는다(무효 상태가 poRequested보다 우선).
    expect(deriveOrderPipelineBucket('CANCELED', 'OK', true)).toBe('other');
    expect(deriveOrderPipelineBucket('RETURNED', 'OK', true)).toBe('other');
  });
});
