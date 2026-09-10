import { describe, expect, it } from 'vitest';
import {
  SETTLEMENT_PENDING_MAX_AGE_DAYS,
  decideSettlementQueryPlan,
  type ClaimedOrderRow,
  type SettlementCaseRow,
  type SnapshotOrderCountRow,
} from '../settlement-pending-dates';

/**
 * 조회 대상 날짜 선정 계약. `todayKey` 를 인자로 받는 순수 함수라 고정 날짜 픽스처가
 * 시한폭탄이 되지 않는다(P9).
 */

const TODAY = '2026-09-10';

function caseRow(over: Partial<SettlementCaseRow> & { productOrderId: string }): SettlementCaseRow {
  return {
    settleType: 'QUICK_SETTLE_ORIGINAL',
    productOrderType: 'PROD_ORDER',
    payDate: new Date(`${TODAY}T00:00:00.000Z`),
    settleExpectAmount: 10_000,
    settled: false,
    ...over,
  };
}

function plan(args: {
  cases?: SettlementCaseRow[];
  claimedOrders?: ClaimedOrderRow[];
  snapshots?: SnapshotOrderCountRow[];
}) {
  return decideSettlementQueryPlan({
    todayKey: TODAY,
    cases: args.cases ?? [],
    claimedOrders: args.claimedOrders ?? [],
    snapshots: args.snapshots ?? [],
  });
}

describe('decideSettlementQueryPlan — 대기 집합에서 날짜를 뽑는다', () => {
  it('대기 주문도 새 주문도 없으면 0콜이다', () => {
    const result = plan({ snapshots: [{ snapshotDate: TODAY, ordersCount: 0 }] });
    expect(result.dates).toEqual([]);
    expect(result.estimatedCalls).toBe(0);
  });

  it('정산완료 행이 없는 주문의 결제일을 부른다', () => {
    const result = plan({ cases: [caseRow({ productOrderId: 'A' })] });
    expect(result.dates).toEqual([{ dateKey: TODAY, reasons: ['unsettled-order'], pendingOrders: 1 }]);
    expect(result.estimatedCalls).toBe(1);
  });
});

describe('decideSettlementQueryPlan — 종료 조건(수렴)', () => {
  it('같은 주문에 정산완료 행이 있으면 낡은 미정산 사본은 대기에서 빠진다', () => {
    // 실측 회귀(2026-09-10): 남아 있던 미정산 행의 대부분이 이 부류였다 — 주문 단위로 접지
    // 않고 행 단위로 세면 이미 끝난 주문이 매일 되살아난다.
    const result = plan({
      cases: [
        caseRow({ productOrderId: 'A', settleType: 'NORMAL_SETTLE_ORIGINAL', settled: false }),
        caseRow({ productOrderId: 'A', settleType: 'QUICK_SETTLE_ORIGINAL', settled: true }),
      ],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedBySettled).toBe(1);
  });

  it('취소·반품 주문은 대기에서 빠진다', () => {
    // 실측 회귀: 나머지는 전부 취소 주문이라 영영 정산되지 않을 질문이었다.
    const result = plan({
      cases: [caseRow({ productOrderId: 'A' })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedByClaim).toBe(1);
  });

  it('비상품 원장(배송비 등)이 정산돼도 그 주문의 상품 결제는 계속 기다린다', () => {
    // 안 거르면 배송비 원장 하나가 정산 완료된 것만으로 상품 결제까지 「끝났다」로 읽혀,
    // 그 주문이 나이 제한도 없이 영구 배제된다.
    const result = plan({
      cases: [
        caseRow({ productOrderId: 'A', settled: false }),
        caseRow({ productOrderId: 'A', productOrderType: 'DELIVERY', settleType: 'QUICK_SETTLE_DELIVERY', settled: true }),
      ],
    });
    expect(result.dates).toEqual([{ dateKey: TODAY, reasons: ['unsettled-order'], pendingOrders: 1 }]);
    expect(result.counters.droppedBySettled).toBe(0);
  });

  it('결제일을 모르는 미정산 행은 계획에 넣지 않되 센다', () => {
    // 날짜 축 조회로는 원리적으로 닿을 수 없다 — 조용히 사라지면 「대기 0」이 거짓말이 된다.
    const result = plan({ cases: [caseRow({ productOrderId: 'A', payDate: null })] });
    expect(result.dates).toEqual([]);
    expect(result.counters.unknownPayDate).toBe(1);
  });

  it('상한을 넘긴 결제 건은 포기한다', () => {
    const tooOld = '2026-08-20'; // TODAY − 21일 (상한 10일 밖)
    const result = plan({ cases: [caseRow({ productOrderId: 'A', payDate: new Date(`${tooOld}T00:00:00.000Z`) })] });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedByAge).toBe(1);
    expect(SETTLEMENT_PENDING_MAX_AGE_DAYS).toBe(10);
  });
});

describe('decideSettlementQueryPlan — 원장을 못 받은 날', () => {
  it('주문이 있는데 그 결제일의 원장이 하나도 없으면 부른다', () => {
    // 크론이 며칠 멈춰도 그 구간이 조회 대상에서 사라지지 않게 하는 경로다.
    const result = plan({ snapshots: [{ snapshotDate: '2026-09-08', ordersCount: 9 }] });
    expect(result.dates).toEqual([{ dateKey: '2026-09-08', reasons: ['no-ledger-yet'], pendingOrders: 0 }]);
  });

  it('그 결제일의 원장을 이미 받았으면 부르지 않는다', () => {
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settled: true })],
      snapshots: [{ snapshotDate: TODAY, ordersCount: 9 }],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.datesWithoutLedger).toBe(0);
  });
});

describe('decideSettlementQueryPlan — 취소 차감 재진입', () => {
  const settledOriginal = caseRow({ productOrderId: 'A', settleType: 'QUICK_SETTLE_ORIGINAL', settled: true });

  it('원거래가 정산됐는데 차감 행이 없으면 그 결제일을 다시 부른다', () => {
    // 오너가 말한 예외(사후 불량 반품·배송지연)를 넓은 상시 창이 아니라 **취소가 실제로
    // 일어났을 때만** 1콜로 받는 경로다.
    const result = plan({
      cases: [settledOriginal],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.dates).toEqual([{ dateKey: TODAY, reasons: ['claim-without-deduction'], pendingOrders: 1 }]);
  });

  it('차감 행이 도착하면 재진입이 멈춘다', () => {
    const result = plan({
      cases: [settledOriginal, caseRow({ productOrderId: 'A', settleType: 'QUICK_SETTLE_CANCEL', settled: true })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.claimsAwaitingDeduction).toBe(0);
  });

  it('정산 전에 취소된 주문은 재진입하지 않는다(차감할 돈이 없다)', () => {
    // 이 조건이 없으면 이 이유가 종전 구조와 똑같이 수렴하지 않는다.
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settled: false })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.claimsAwaitingDeduction).toBe(0);
  });

  it('이름에 CANCEL 이 없어도 금액이 음수면 차감으로 본다', () => {
    // `settleType` 전체 목록이 확정 문서화돼 있지 않다 — 이름만 보면 못 알아본 차감 때문에
    // 재진입이 클레임 창 내내 같은 날짜를 다시 부른다.
    const result = plan({
      cases: [
        settledOriginal,
        caseRow({ productOrderId: 'A', settleType: 'QUICK_SETTLE_ADJUST', settleExpectAmount: -10_000, settled: true }),
      ],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.dates).toEqual([]);
  });

  it('취소 재진입은 대기 상한(10일)보다 긴 창을 본다', () => {
    const old = '2026-08-20'; // 대기 상한 밖, 클레임 창(60일) 안
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settleType: 'QUICK_SETTLE_ORIGINAL', settled: true, payDate: new Date(`${old}T00:00:00.000Z`) })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: old }],
    });
    expect(result.dates).toEqual([{ dateKey: old, reasons: ['claim-without-deduction'], pendingOrders: 1 }]);
  });
});
