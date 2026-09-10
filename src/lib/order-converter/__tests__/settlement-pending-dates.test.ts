import { describe, expect, it } from 'vitest';
import {
  SETTLEMENT_MAX_DATES_PER_RUN,
  SETTLEMENT_ORDER_DATE_RECHECK_DAYS,
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

/** KST 날짜키에 일수를 더한다(테스트 지역 헬퍼 — 픽스처가 상수와 함께 움직이게 한다). */
function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    expect(result.counters.unknownPayDateOrders).toBe(1);
  });

  it('취소로 끝난 주문은 결제일이 없어도 unknownPayDate 로 세지 않는다', () => {
    // 이 카운터는 「조회 방식을 바꿔야 하나」를 재는 신호다 — 이미 끝난 건이 영구 바닥으로
    // 앉으면 신호가 흐려진다.
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', payDate: null })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.counters.unknownPayDateOrders).toBe(0);
  });

  it('상한을 넘긴 결제 건은 포기한다', () => {
    const tooOld = '2026-08-20'; // TODAY − 21일 (상한 10일 밖)
    const result = plan({ cases: [caseRow({ productOrderId: 'A', payDate: new Date(`${tooOld}T00:00:00.000Z`) })] });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedByAge).toBe(1);
    expect(SETTLEMENT_PENDING_MAX_AGE_DAYS).toBe(10);
  });
});

describe('decideSettlementQueryPlan — 주문이 있었던 최근 날짜 재확인', () => {
  it('주문이 있었던 날은 대기 주문이 없어 보여도 재확인 기간 동안 다시 부른다', () => {
    // 원장 행이 결제 직후 한꺼번에 안 생기면, 늦게 생긴 행은 `cases` 에 없어 대기 판정으로는
    // 영영 안 잡힌다 — 라벨이 아니라 행 자체가 빈다.
    const result = plan({ snapshots: [{ snapshotDate: '2026-09-08', ordersCount: 9 }] });
    expect(result.dates).toEqual([{ dateKey: '2026-09-08', reasons: ['recent-order-date'], pendingOrders: 0 }]);
    expect(result.counters.datesRechecked).toBe(1);
  });

  it('원장을 이미 받았어도 재확인 기간 안이면 다시 부른다', () => {
    // ⛔ 「원장이 있으니 받았다」로 접으면, 같은 날 일부 주문의 원장만 먼저 온 경우 나머지가
    //    영영 안 채워진다. 판정을 개수 대조로 바꾸는 것도 금지다(모수가 다르다).
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settled: true })],
      snapshots: [{ snapshotDate: TODAY, ordersCount: 1 }],
    });
    expect(result.dates).toEqual([{ dateKey: TODAY, reasons: ['recent-order-date'], pendingOrders: 0 }]);
  });

  it('재확인 창의 마지막 날은 포함한다(경계)', () => {
    // ⚠️ 경계를 안 고정하면 `<` ↔ `<=` 변이로 창이 하루 줄어도 테스트가 전부 초록이다.
    const lastIncluded = addDays(TODAY, -(SETTLEMENT_ORDER_DATE_RECHECK_DAYS - 1));
    const result = plan({ snapshots: [{ snapshotDate: lastIncluded, ordersCount: 1 }] });
    expect(result.dates.map((d) => d.dateKey)).toEqual([lastIncluded]);
  });

  it('재확인 창 바로 밖의 날은 부르지 않는다(경계)', () => {
    const justOutside = addDays(TODAY, -SETTLEMENT_ORDER_DATE_RECHECK_DAYS);
    const result = plan({ snapshots: [{ snapshotDate: justOutside, ordersCount: 1 }] });
    expect(result.dates).toEqual([]);
  });

  it('재확인 기간을 벗어난 날은 부르지 않는다', () => {
    const old = addDays(TODAY, -(SETTLEMENT_ORDER_DATE_RECHECK_DAYS + 1));
    const result = plan({ snapshots: [{ snapshotDate: old, ordersCount: 9 }] });
    expect(result.dates).toEqual([]);
    // 원장을 한 번도 못 받은 채 창을 벗어났다 = 백필 대상. 조용히 사라지지 않는다.
    expect(result.counters.droppedByAgeDates).toBe(1);
  });

  it('원장 수가 스냅샷보다 적어도 그것만으로는 부르지 않는다(관측 전용)', () => {
    // 두 수는 같은 술어로 센 값이 아니다 — `order-fetch-window` 가 차단 근거 금지를 명시한다.
    const old = addDays(TODAY, -(SETTLEMENT_ORDER_DATE_RECHECK_DAYS + 1));
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settled: true, payDate: new Date(`${old}T00:00:00.000Z`) })],
      snapshots: [{ snapshotDate: old, ordersCount: 5 }],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.ledgerShortDates).toBe(1);
  });
});

describe('decideSettlementQueryPlan — 조용히 빠지는 길이 없다', () => {
  it('비상품 원장 행은 건너뛰되 센다', () => {
    // 🪤 네이버가 productOrderType 표기를 바꾸면 전 행이 여기로 빠져 계획이 아무 이유 없이
    //    비어 보인다 — 「할 일 0」과 구분되지 않는다.
    const result = plan({ cases: [caseRow({ productOrderId: 'A', productOrderType: 'DELIVERY' })] });
    expect(result.counters.droppedByNonProductLedgerRows).toBe(1);
  });

  it('원거래가 정산 안 된 클레임은 건너뛰되 센다', () => {
    const result = plan({
      cases: [caseRow({ productOrderId: 'A', settled: false })],
      claimedOrders: [{ productOrderId: 'A', payDateKey: TODAY }],
    });
    expect(result.counters.claimsWithoutSettledOriginal).toBe(1);
  });

  it('미래 결제일은 계획에 넣지 않는다', () => {
    // 안 막으면 잘못 들어온 행 하나가 그 날짜를 매일 계획에 올린다.
    const future = addDays(TODAY, 3);
    const result = plan({ cases: [caseRow({ productOrderId: 'A', payDate: new Date(`${future}T00:00:00.000Z`) })] });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedByAge).toBe(1);
  });

  it('날짜가 상한을 넘으면 오래된 쪽을 남기고 잘린 수를 신고한다', () => {
    // 차감이 끝내 안 오는 주문이 여러 결제일에 흩어지면 계획이 종전 고정 달력보다 커질 수 있다.
    const cases = [];
    const claimedOrders = [];
    for (let i = 0; i < SETTLEMENT_MAX_DATES_PER_RUN + 3; i++) {
      const dateKey = addDays(TODAY, -(i + 10));
      cases.push(caseRow({ productOrderId: `A${i}`, settled: true, payDate: new Date(`${dateKey}T00:00:00.000Z`) }));
      claimedOrders.push({ productOrderId: `A${i}`, payDateKey: dateKey });
    }
    const result = plan({ cases, claimedOrders });
    expect(result.estimatedCalls).toBe(SETTLEMENT_MAX_DATES_PER_RUN);
    expect(result.counters.truncatedDates).toBe(3);
    // 오래된 쪽이 남는다 — 최근 날짜는 다음 회차에 다시 들어온다.
    expect(result.dates[0].dateKey).toBe(addDays(TODAY, -(SETTLEMENT_MAX_DATES_PER_RUN + 2 + 10)));
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
    expect(result.counters.claimsAwaitingDeduction).toBe(0);
  });

  it('미정산 음수 행은 차감으로 보지 않는다(원거래가 조용히 빠지지 않게)', () => {
    // 「차감 계열은 음수 흐름」은 계열 단위 서술이라, 미정산 행까지 음수만으로 차감 취급하면
    // 수수료·혜택 구성 때문에 음수가 된 원거래가 카운터 없이 대기에서 빠진다.
    const result = plan({
      cases: [caseRow({ productOrderId: 'B', settleType: 'QUICK_SETTLE_ORIGINAL', settleExpectAmount: -1_000, settled: false })],
    });
    expect(result.dates).toEqual([{ dateKey: TODAY, reasons: ['unsettled-order'], pendingOrders: 1 }]);
    expect(result.counters.droppedByDeductionRows).toBe(0);
  });

  it('미정산 차감 행이 대기에서 빠질 때는 카운터가 붙는다', () => {
    const result = plan({
      cases: [caseRow({ productOrderId: 'B', settleType: 'QUICK_SETTLE_CANCEL', settled: false })],
    });
    expect(result.dates).toEqual([]);
    expect(result.counters.droppedByDeductionRows).toBe(1);
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
