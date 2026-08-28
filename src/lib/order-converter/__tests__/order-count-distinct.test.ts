import { describe, it, expect } from 'vitest';
import { INVALID_ORDER_STATUSES, resolveOrderCountKey } from '../group-orders';

/**
 * 주문건수(주문번호 distinct) 집계 규칙 회귀 테스트.
 * 라우트(campaigns/route.ts, campaigns/[id]/route.ts)는 유효 분기 안에서
 *   `const k = resolveOrderCountKey(order); if (k) validOrderKeys.add(k)`
 * 로 집계한다. 여기서는 그 규칙을 그대로 재현해 의미를 고정한다.
 */
function countDistinctValidOrders(orders: any[]): number {
  const keys = new Set<string>();
  for (const o of orders) {
    if (INVALID_ORDER_STATUSES.includes(o?.productOrderStatus)) continue; // 전량취소/결제대기 라인 제외
    const k = resolveOrderCountKey(o);
    if (k) keys.add(k);
  }
  return keys.size;
}

describe('INVALID_ORDER_STATUSES (네이버 enum 정합 — 2026-07-10 오집계 실사고 회귀 가드)', () => {
  // 네이버 커머스 productOrderStatus 실제 enum과 문자열이 정확히 일치해야 결제대기·미결제취소
  // 주문이 판매로 새어들지 않는다. 과거 'PAY_WAITING'(오타)·'CANCELED_BY_NOPAYMENT'(누락)으로
  // 수량·매출·주문수가 부풀려졌다. 이 테스트는 그 정확한 문자열을 고정한다.
  it('결제대기는 네이버 실제값 PAYMENT_WAITING으로 제외한다 (오타 PAY_WAITING 금지)', () => {
    expect(INVALID_ORDER_STATUSES).toContain('PAYMENT_WAITING');
    expect(INVALID_ORDER_STATUSES).not.toContain('PAY_WAITING');
  });
  it('미결제 자동취소 CANCELED_BY_NOPAYMENT를 제외 목록에 포함한다', () => {
    expect(INVALID_ORDER_STATUSES).toContain('CANCELED_BY_NOPAYMENT');
  });
  it('취소·반품·교환도 계속 제외한다', () => {
    for (const s of ['CANCELED', 'RETURNED', 'EXCHANGED']) {
      expect(INVALID_ORDER_STATUSES).toContain(s);
    }
  });
  it('판매로 집계돼야 하는 상태는 제외 목록에 없다', () => {
    for (const s of ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED']) {
      expect(INVALID_ORDER_STATUSES).not.toContain(s);
    }
  });
});

describe('resolveOrderCountKey', () => {
  it('orderId가 있으면 orderId를 키로 쓴다', () => {
    expect(resolveOrderCountKey({ orderId: 'O1', productOrderId: 'P1' })).toBe('O1');
  });
  it('orderId가 없으면 productOrderId로 폴백한다', () => {
    expect(resolveOrderCountKey({ productOrderId: 'P1' })).toBe('po:P1');
  });
  it('공백을 trim한다', () => {
    expect(resolveOrderCountKey({ orderId: '  O1 ' })).toBe('O1');
  });
  it('둘 다 없으면 빈 문자열(집계 제외)', () => {
    expect(resolveOrderCountKey({})).toBe('');
  });
});

describe('countDistinctValidOrders (주문건수 규칙)', () => {
  it('같은 주문의 여러 상품주문번호(옵션+사은품)는 1건으로 합쳐진다', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DISPATCH_WAIT' }, // 본품
      { orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'DISPATCH_WAIT' }, // 추가옵션
      { orderId: 'O1', productOrderId: 'P3', productOrderStatus: 'DISPATCH_WAIT' }, // 사은품
    ];
    expect(countDistinctValidOrders(orders)).toBe(1);
  });

  it('서로 다른 주문은 각각 1건', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED' },
      { orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'DELIVERING' },
    ];
    expect(countDistinctValidOrders(orders)).toBe(2);
  });

  it('한 주문의 모든 라인이 취소되면 그 주문은 제외된다(전량취소)', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'CANCELED' },
      { orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'RETURNED' },
    ];
    expect(countDistinctValidOrders(orders)).toBe(0);
  });

  it('부분취소(유효 라인 1개 이상)면 그 주문은 1건으로 유지된다', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'CANCELED' },   // 일부 취소
      { orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'DISPATCH_WAIT' }, // 유효 라인 잔존
    ];
    expect(countDistinctValidOrders(orders)).toBe(1);
  });

  it('orderId 결측 라인은 productOrderId로 개별 집계(누락 방지)', () => {
    const orders = [
      { productOrderId: 'P1', productOrderStatus: 'PAYED' },
      { productOrderId: 'P2', productOrderStatus: 'PAYED' },
    ];
    expect(countDistinctValidOrders(orders)).toBe(2);
  });

  it('결제대기(PAYMENT_WAITING) 주문은 판매로 집계되지 않는다 (실사고 회귀)', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYMENT_WAITING' },
      { orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'DELIVERING' },
    ];
    expect(countDistinctValidOrders(orders)).toBe(1);
  });

  it('미결제 자동취소(CANCELED_BY_NOPAYMENT) 주문은 판매로 집계되지 않는다 (실사고 회귀)', () => {
    const orders = [
      { orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'CANCELED_BY_NOPAYMENT' },
      { orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PURCHASE_DECIDED' },
    ];
    expect(countDistinctValidOrders(orders)).toBe(1);
  });
});
