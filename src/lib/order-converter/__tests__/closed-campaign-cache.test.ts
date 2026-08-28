import { describe, it, expect } from 'vitest';
import {
  composeIntradayFromFrozen,
  computeClosedCampaignCache,
  parseFrozenIntradayBuckets,
  resolveClosedCampaignPeriod,
  type FrozenIntradayBuckets,
} from '../closed-campaign-cache';
import { SNAPSHOT_INTRADAY_BUCKET_VERSION } from '../daily-aggregate';

describe('resolveClosedCampaignPeriod — 마감 스냅샷 컷오프(라이브와 동일 SSOT)', () => {
  it('salePeriod 종료는 KST 그 날 끝까지 포함(과거 UTC 23:59:59Z로 새던 버그 회귀 방지)', () => {
    const { start, end } = resolveClosedCampaignPeriod({ salePeriod: '2026.07.06 ~ 2026.07.13' });
    expect(start?.getTime()).toBe(new Date('2026-07-06T00:00:00.000+09:00').getTime());
    expect(end?.getTime()).toBe(new Date('2026-07-13T23:59:59.999+09:00').getTime());
  });

  it('날짜만 저장된 endDate(UTC 자정=KST 09:00)도 KST 종일로 보정 — 마감 당일 오전 매출 누락 방지', () => {
    const { end } = resolveClosedCampaignPeriod({ endDate: new Date('2026-07-13T00:00:00.000Z') });
    expect(end?.getTime()).toBe(new Date('2026-07-13T23:59:59.999+09:00').getTime());
  });
});

const CAMP = {
  name: '테스트 캠페인',
  productId: null,
  mappings: [{ productName: '테스트 캠페인', optionName: '옵션A', price: 10000 }],
};
const WINDOW = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-31T23:59:59Z') };

function order(over: Record<string, any>) {
  return {
    productName: '테스트 캠페인',
    productOption: '옵션A',
    quantity: 1,
    totalPaymentAmount: 10000,
    paymentDate: '2026-07-10T09:00:00+09:00',
    ...over,
  };
}

describe('computeClosedCampaignCache — 유효주문 집계(마감 캐시 SSOT)', () => {
  it('판매 상태(PAYED/DELIVERING/PURCHASE_DECIDED)만 수량·매출·주문에 집계한다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'DELIVERING' }),
      order({ orderId: 'O3', productOrderId: 'P3', productOrderStatus: 'PURCHASE_DECIDED' }),
    ], new Set(), WINDOW);
    expect(r.cachedTotalOrders).toBe(3);
    expect(r.cachedTotalQuantity).toBe(3);
    expect(r.cachedTotalRevenue).toBe(30000);
    expect(r.cachedDistinctOrderCount).toBe(3);
  });

  it('결제대기(PAYMENT_WAITING)·미결제취소(CANCELED_BY_NOPAYMENT)는 판매로 집계하지 않는다 (2026-07-10 실사고 회귀)', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DELIVERING' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYMENT_WAITING' }),
      order({ orderId: 'O3', productOrderId: 'P3', productOrderStatus: 'CANCELED_BY_NOPAYMENT' }),
      order({ orderId: 'O4', productOrderId: 'P4', productOrderStatus: 'CANCELED' }),
      order({ orderId: 'O5', productOrderId: 'P5', productOrderStatus: 'RETURNED' }),
    ], new Set(), WINDOW);
    // 유효한 건 DELIVERING 1건뿐
    expect(r.cachedTotalOrders).toBe(1);
    expect(r.cachedTotalQuantity).toBe(1);
    expect(r.cachedTotalRevenue).toBe(10000);
    expect(r.cachedDistinctOrderCount).toBe(1);
  });

  it('판매기간(window) 밖 주문은 제외한다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T09:00:00+09:00' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYED', paymentDate: '2026-08-15T09:00:00+09:00' }),
    ], new Set(), WINDOW);
    expect(r.cachedTotalOrders).toBe(1);
    expect(r.cachedTotalQuantity).toBe(1);
  });
});

describe('computeClosedCampaignCache — 일별 주문건수는 distinct(주문번호 기준)여야 한다', () => {
  type DailyStat = { date: string; orders: number; quantity: number; options: { name: string; orders: number; quantity: number; ratio: number }[] };

  it('한 주문(orderId)의 여러 상품주문 라인은 일별 주문건수 1건으로 합쳐진다(라인수 부풀림 방지)', () => {
    const r = computeClosedCampaignCache(CAMP, [
      // 같은 주문 O1의 두 상품주문 라인(옵션/색상 분리) — 1건으로 세어야 함
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DELIVERING', quantity: 1 }),
      order({ orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'DELIVERING', quantity: 2 }),
      // 별개 주문 O2
      order({ orderId: 'O2', productOrderId: 'P3', productOrderStatus: 'PAYED', quantity: 1 }),
    ], new Set(), WINDOW);

    // 카드 주문건수: distinct 주문번호 = {O1, O2} = 2
    expect(r.cachedDistinctOrderCount).toBe(2);
    // 수량은 라인 합산(변경 없음)
    expect(r.cachedTotalQuantity).toBe(4);

    const daily = JSON.parse(r.cachedDailyStats) as DailyStat[];
    const day = daily.find((d) => d.date === '2026-07-10')!;
    // 버그였던 지점: 예전엔 라인수 3으로 부풀려짐 → 이제 distinct 2
    expect(day.orders).toBe(2);
    expect(day.quantity).toBe(4);

    // 옵션별 주문건수도 distinct: 옵션A를 산 주문은 {O1, O2} = 2건
    const optA = day.options.find((o) => o.name.includes('옵션A'))!;
    expect(optA.orders).toBe(2);
    expect(optA.quantity).toBe(4);
    // 판매 비중은 quantity 기반(옵션 1종이므로 100%)
    expect(optA.ratio).toBeCloseTo(100, 5);
  });

  it('정합성 불변식: 일자별 orders 합계 === 카드 distinctOrderCount', () => {
    const r = computeClosedCampaignCache(CAMP, [
      // 7/10: O1(2라인) + O2 = distinct 2
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DELIVERING', paymentDate: '2026-07-10T09:00:00+09:00' }),
      order({ orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'DELIVERING', paymentDate: '2026-07-10T12:00:00+09:00' }),
      order({ orderId: 'O2', productOrderId: 'P3', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T15:00:00+09:00' }),
      // 7/11: O3(2라인) = distinct 1
      order({ orderId: 'O3', productOrderId: 'P4', productOrderStatus: 'PAYED', paymentDate: '2026-07-11T09:00:00+09:00' }),
      order({ orderId: 'O3', productOrderId: 'P5', productOrderStatus: 'PAYED', paymentDate: '2026-07-11T10:00:00+09:00' }),
    ], new Set(), WINDOW);

    const daily = JSON.parse(r.cachedDailyStats) as DailyStat[];
    const dailySum = daily.reduce((s, d) => s + d.orders, 0);
    expect(dailySum).toBe(r.cachedDistinctOrderCount);
    expect(r.cachedDistinctOrderCount).toBe(3); // {O1, O2, O3}
  });
});

describe('computeClosedCampaignCache — 마감 시 인사이트 스냅샷을 동결한다(cachedInsights)', () => {
  type Insights = {
    inflow: { path: string; orders: number; quantity: number; revenue: number }[];
    device: { mobile: number; pc: number; unknown: number };
    paymentMeans: { means: string; orders: number }[];
    membership: { orders: number; ratio: number };
    buyers: { unique: number; repeat: number; repeatRatio: number };
    claims: { canceled: number; returned: number; exchanged: number; total: number; ratio: number };
  };

  it('유입경로·기기·결제수단·멤버십·구매자 인사이트를 결제(주문) 단위로 스냅샷한다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DELIVERING', inflowPath: '마케팅링크', payLocationType: 'MOBILE', paymentMeans: '신용카드 간편결제', ordererNo: '1001' }),
      // 같은 결제 O1의 2번째 라인 — orders는 1건으로 dedup, quantity는 라인 합산
      order({ orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'DELIVERING', quantity: 2, inflowPath: '마케팅링크', payLocationType: 'MOBILE', paymentMeans: '신용카드 간편결제', ordererNo: '1001' }),
      order({ orderId: 'O2', productOrderId: 'P3', productOrderStatus: 'PAYED', inflowPath: '네이버쇼핑', payLocationType: 'PC', paymentMeans: '네이버페이 포인트', ordererNo: '1002', isMembershipSubscribed: true }),
    ], new Set(), WINDOW);

    const ins = JSON.parse(r.cachedInsights) as Insights;

    // 유입경로: 마케팅링크는 결제 1건(라인 2개지만 dedup)·수량 3(1+2), 네이버쇼핑 1건
    const mk = ins.inflow.find((i) => i.path === '마케팅링크')!;
    expect(mk.orders).toBe(1);
    expect(mk.quantity).toBe(3);
    expect(ins.inflow.find((i) => i.path === '네이버쇼핑')!.orders).toBe(1);

    // 기기: 결제 단위 — 모바일 1(O1), PC 1(O2)
    expect(ins.device).toMatchObject({ mobile: 1, pc: 1 });
    // 결제수단·멤버십도 결제 단위
    expect(ins.paymentMeans.find((p) => p.means === '신용카드 간편결제')!.orders).toBe(1);
    expect(ins.membership.orders).toBe(1);
    // 구매자: distinct ordererNo 2명, 반복구매 0
    expect(ins.buyers.unique).toBe(2);
    expect(ins.buyers.repeat).toBe(0);
  });

  it('취소·반품·교환은 유효집계에서 빠져도 클레임 인사이트에는 결제 단위로 잡힌다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'DELIVERING', ordererNo: '1001' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'CANCELED', ordererNo: '1002' }),
      // 같은 취소 결제의 2번째 라인 — 클레임 1건으로 dedup
      order({ orderId: 'O2', productOrderId: 'P3', productOrderStatus: 'CANCELED', ordererNo: '1002' }),
      order({ orderId: 'O3', productOrderId: 'P4', productOrderStatus: 'RETURNED', ordererNo: '1003' }),
    ], new Set(), WINDOW);

    // 유효주문은 DELIVERING 1건뿐
    expect(r.cachedDistinctOrderCount).toBe(1);

    const ins = JSON.parse(r.cachedInsights) as Insights;
    expect(ins.claims.canceled).toBe(1); // O2의 2라인 → 1건
    expect(ins.claims.returned).toBe(1);
    expect(ins.claims.total).toBe(2);
    // 취소·반품율 = 클레임 / (유효주문 + 클레임) = 2 / (1 + 2)
    expect(ins.claims.ratio).toBeCloseTo((2 / 3) * 100, 5);
  });
});

/**
 * 교차 귀속 가드 — 라이브 handler 의 belongsToOther 와 규칙을 맞춘다.
 *
 * 실사고(2026-07-23 실데이터 대조로 확인): 스토어 상품이 하나뿐인 (날짜×옵션) 칸을 마감 캠페인
 * 두 개가 각자 전량 집계해, 두 캐시의 합이 원천에 물리적으로 존재하는 수량을 초과했다. 원인은
 * 마감 경로에만 이 가드가 없던 것 — 매핑 집합이 같은 두 캠페인은 매핑만으로 구별되지 않는데,
 * 마감 경로는 매핑 매칭이면 무조건 claim 했다.
 */
describe('computeClosedCampaignCache — 교차 귀속 가드(belongsToOther 패리티)', () => {
  const A = { id: 'campA', name: 'A마켓', productId: null, mappings: [{ productName: '공용상품', optionName: '옵션A', price: 10000 }] };
  // B 는 A 와 매핑이 완전히 같다 — 매핑만으로는 두 캠페인을 구별할 수 없는 실제 구성.
  const B = { id: 'campB', name: 'B마켓', productId: null, mappings: [{ productName: '공용상품', optionName: '옵션A', price: 10000 }] };
  const PEERS = [{ id: 'campA', name: 'A마켓' }, { id: 'campB', name: 'B마켓' }];

  // 상품명에 A마켓이 명시된 주문 — 소유자는 A 하나뿐이어야 한다.
  const ownedByA = order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', productName: 'A마켓 공용상품', productOption: '옵션A' });

  it('상품명이 다른 캠페인명을 포함하면 매핑이 맞아도 집계하지 않는다', () => {
    const r = computeClosedCampaignCache(B, [ownedByA], new Set(), WINDOW, PEERS);
    expect(r.cachedTotalQuantity).toBe(0);
    expect(r.cachedTotalOrders).toBe(0);
    expect(r.cachedTotalRevenue).toBe(0);
  });

  it('두 캠페인 집계의 합이 원천 수량을 초과하지 않는다 (이중계상 회귀)', () => {
    const orders = [ownedByA];
    const ra = computeClosedCampaignCache(A, orders, new Set(), WINDOW, PEERS);
    const rb = computeClosedCampaignCache(B, orders, new Set(), WINDOW, PEERS);
    expect(ra.cachedTotalQuantity).toBe(1); // 이름이 박힌 A 가 가져간다
    expect(rb.cachedTotalQuantity).toBe(0);
    expect(ra.cachedTotalQuantity + rb.cachedTotalQuantity).toBe(1); // 원천 실재 수량과 동일
  });

  it('자기 이름이 박힌 주문은 peer 가 있어도 유지된다 (이름 매칭 short-circuit)', () => {
    const ownedByB = order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYED', productName: 'B마켓 공용상품', productOption: '옵션A' });
    const r = computeClosedCampaignCache(B, [ownedByB], new Set(), WINDOW, PEERS);
    expect(r.cachedTotalQuantity).toBe(1);
  });

  it('peer 를 안 넘기면 기존 동작 그대로 — 가드 없음(하위호환)', () => {
    const r = computeClosedCampaignCache(B, [ownedByA], new Set(), WINDOW);
    expect(r.cachedTotalQuantity).toBe(1); // 가드 없이는 B 도 claim = 수정 전 동작
  });

  it('자기 자신은 peer 에서 제외된다 (자기 이름으로 자기를 배제하지 않음)', () => {
    // 어느 캠페인명도 안 박힌 상품명 — 매핑 폴백으로만 귀속된다.
    const viaMapping = order({ orderId: 'O3', productOrderId: 'P3', productOrderStatus: 'PAYED', productName: '공용상품', productOption: '옵션A' });
    const r = computeClosedCampaignCache(A, [viaMapping], new Set(), WINDOW, PEERS);
    expect(r.cachedTotalQuantity).toBe(1); // 매핑 폴백으로 A 가 정상 claim
  });
});

/**
 * 같은 상품 링크를 여러 캠페인이 순차로 쓰는 운영(오너 확정 2026-07-23).
 *
 * 실운영: 한 상품 링크의 상품명을 바꿔가며 셀러를 교체해 회차를 이어 돌린다. 이때 주문
 * 스냅샷의 productName 은 **그 라인이 마지막으로 동기화된 시점의 상품명**이라, 이름을 바꾸면
 * 그 뒤 재싱크된 **과거 주문까지** 새 이름을 갖는다(실측: 같은 날 안에서 결제 시각순으로 두
 * 이름이 번갈아 등장). productId 도 같으므로 분리 신호는 **결제 시각 × 캠페인 창**뿐이다.
 */
describe('computeClosedCampaignCache — 같은 링크 순차 전환(셀러 교체)', () => {
  const MAPPINGS = [{ productName: '공용상품', optionName: '옵션A', price: 10000 }];
  // 1회차: 07-01~07-10 / 2회차: 07-11~07-20 — 창이 겹치지 않는다(정상 운영).
  const R1 = { id: 'r1', name: '셀러가 마켓', productId: null, mappings: MAPPINGS };
  const R2 = { id: 'r2', name: '셀러나 마켓', productId: null, mappings: MAPPINGS };
  const PEERS = [
    { id: 'r1', name: '셀러가 마켓', salePeriod: '2026.07.01 ~ 2026.07.10' },
    { id: 'r2', name: '셀러나 마켓', salePeriod: '2026.07.11 ~ 2026.07.20' },
  ];
  const W1 = { start: new Date('2026-07-01T00:00:00+09:00'), end: new Date('2026-07-10T23:59:59.999+09:00') };
  const W2 = { start: new Date('2026-07-11T00:00:00+09:00'), end: new Date('2026-07-20T23:59:59.999+09:00') };

  // 1회차 기간(07-05)에 결제됐지만, 상품명 변경 후 재동기화돼 **2회차 셀러 이름**을 달고 있는 주문.
  const renamedOldOrder = order({
    orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED',
    productName: '셀러나 마켓 공용상품', productOption: '옵션A',
    paymentDate: '2026-07-05T12:00:00+09:00',
  });

  it('이름이 바뀐 옛 주문도 1회차가 집계한다 — 2회차 창이 그 결제시각을 담지 못하므로 양보하지 않음', () => {
    const r = computeClosedCampaignCache(R1, [renamedOldOrder], new Set(), W1, PEERS);
    expect(r.cachedTotalQuantity).toBe(1);
  });

  it('2회차는 그 주문을 집계하지 않는다 (창 밖)', () => {
    const r = computeClosedCampaignCache(R2, [renamedOldOrder], new Set(), W2, PEERS);
    expect(r.cachedTotalQuantity).toBe(0);
  });

  it('침묵 누락 회귀: 두 회차 합이 원천 수량과 같다 (아무도 안 세는 구멍 없음)', () => {
    const a = computeClosedCampaignCache(R1, [renamedOldOrder], new Set(), W1, PEERS);
    const b = computeClosedCampaignCache(R2, [renamedOldOrder], new Set(), W2, PEERS);
    expect(a.cachedTotalQuantity + b.cachedTotalQuantity).toBe(1);
  });

  it('2회차 기간의 주문은 2회차만 집계한다 (반대 방향도 성립)', () => {
    const newOrder = order({
      orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYED',
      productName: '셀러나 마켓 공용상품', productOption: '옵션A',
      paymentDate: '2026-07-15T12:00:00+09:00',
    });
    const a = computeClosedCampaignCache(R1, [newOrder], new Set(), W1, PEERS);
    const b = computeClosedCampaignCache(R2, [newOrder], new Set(), W2, PEERS);
    expect(a.cachedTotalQuantity).toBe(0); // 1회차 창 밖
    expect(b.cachedTotalQuantity).toBe(1);
  });

  it('창이 겹치는 peer 에는 종전대로 양보한다 (이중계상 가드 유지)', () => {
    const overlapPeers = [
      { id: 'r1', name: '셀러가 마켓', salePeriod: '2026.07.01 ~ 2026.07.20' },
      { id: 'r2', name: '셀러나 마켓', salePeriod: '2026.07.01 ~ 2026.07.20' },
    ];
    const wide = { start: new Date('2026-07-01T00:00:00+09:00'), end: new Date('2026-07-20T23:59:59.999+09:00') };
    const r = computeClosedCampaignCache(R1, [renamedOldOrder], new Set(), wide, overlapPeers);
    expect(r.cachedTotalQuantity).toBe(0); // 상대 창이 담을 수 있으므로 양보
  });

  it('peer 창이 미확정이면 보수적으로 양보한다 (기존 동작 보존)', () => {
    const noWindowPeers = [{ id: 'r2', name: '셀러나 마켓' }];
    const r = computeClosedCampaignCache(R1, [renamedOldOrder], new Set(), W1, noWindowPeers);
    expect(r.cachedTotalQuantity).toBe(0);
  });
});

/**
 * 마감 시 동결하는 10분 인트라데이 버킷(cachedIntradayBuckets).
 *
 * 마감 캠페인은 읽기 경로가 스냅샷 집계(dailyAggregate.bv)를 타지 않아 읽기 시점 합성이
 * 구조적으로 불가능하다 — cachedInsights 와 같은 부류라 마감 시 동결한다. 버킷 경계가
 * live 경로와 갈리면 같은 캠페인이 두 해상도에서 다른 그림이 되므로, 인덱스 산식은
 * daily-aggregate SSOT(resolveIntradayBucketIndex)를 재사용한다.
 */
describe('computeClosedCampaignCache — 인트라데이 버킷 동결', () => {
  const parse = (r: { cachedIntradayBuckets: string }) => JSON.parse(r.cachedIntradayBuckets) as FrozenIntradayBuckets;

  it('버킷 번호는 KST 자정 기준 10분 칸이다 (live 경로와 동일 경계)', () => {
    const r = computeClosedCampaignCache(CAMP, [
      // 09:00 KST = 자정 후 540분 → 54번 칸. UTC 로 계산하면 0번이 나온다(회귀 방지 지점).
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T09:00:00+09:00' }),
      // 09:07 KST → 같은 54번 칸(10분 폭 안)
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T09:07:00+09:00' }),
      // 09:10 KST → 55번 칸
      order({ orderId: 'O3', productOrderId: 'P3', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T09:10:00+09:00' }),
    ], new Set(), WINDOW);
    const frozen = parse(r);
    expect(frozen.bv).toBe(SNAPSHOT_INTRADAY_BUCKET_VERSION);
    expect(frozen.days['2026-07-10']['54']).toEqual([2, 20000]);
    expect(frozen.days['2026-07-10']['55']).toEqual([1, 10000]);
  });

  it('버킷 합이 그날 일별 매출과 일치한다 (같은 분기에서 세는 것의 계약)', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', paymentDate: '2026-07-10T09:00:00+09:00' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'DELIVERING', paymentDate: '2026-07-10T21:30:00+09:00' }),
      order({ orderId: 'O3', productOrderId: 'P3', productOrderStatus: 'PAYED', paymentDate: '2026-07-11T01:05:00+09:00' }),
    ], new Set(), WINDOW);
    const frozen = parse(r);
    const daily = JSON.parse(r.cachedDailyStats) as Array<{ date: string; revenue: number; orders: number }>;
    for (const day of daily) {
      const buckets = Object.values(frozen.days[day.date]);
      expect(buckets.reduce((sum, [, revenue]) => sum + revenue, 0)).toBe(day.revenue);
      expect(buckets.reduce((sum, [orders]) => sum + orders, 0)).toBe(day.orders);
    }
  });

  it('유효하지 않은 상태(취소·결제대기)는 버킷에도 들어가지 않는다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'CANCELED', paymentDate: '2026-07-10T09:00:00+09:00' }),
      order({ orderId: 'O2', productOrderId: 'P2', productOrderStatus: 'PAYMENT_WAITING', paymentDate: '2026-07-10T09:00:00+09:00' }),
    ], new Set(), WINDOW);
    expect(parse(r).days).toEqual({});
  });

  it('교차 귀속 가드로 배제된 주문은 버킷에도 남지 않는다 (별도 루프였다면 샜을 지점)', () => {
    const A = { id: 'campA', name: 'A마켓', productId: null, mappings: [{ productName: '공용상품', optionName: '옵션A', price: 10000 }] };
    const B = { id: 'campB', name: 'B마켓', productId: null, mappings: [{ productName: '공용상품', optionName: '옵션A', price: 10000 }] };
    const PEERS = [{ id: 'campA', name: 'A마켓' }, { id: 'campB', name: 'B마켓' }];
    const ownedByA = order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', productName: 'A마켓 공용상품', productOption: '옵션A' });
    expect(parse(computeClosedCampaignCache(B, [ownedByA], new Set(), WINDOW, PEERS)).days).toEqual({});
    expect(Object.keys(parse(computeClosedCampaignCache(A, [ownedByA], new Set(), WINDOW, PEERS)).days)).toEqual(['2026-07-10']);
  });

  it('시각이 없는 주문은 일별에도 버킷에도 없다 (두 표면이 함께 비어야 한다)', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', paymentDate: null, orderDate: null, orderCreateDate: null }),
    ], new Set(), WINDOW);
    expect(r.cachedTotalQuantity).toBe(1); // 누적에는 잡힌다(기존 동작)
    expect(JSON.parse(r.cachedDailyStats)).toEqual([]);
    expect(parse(r).days).toEqual({});
  });

  it('추가구성상품도 메인 품목과 같은 칸에 합산된다', () => {
    const r = computeClosedCampaignCache(CAMP, [
      order({ orderId: 'O1', productOrderId: 'P1', productOrderStatus: 'PAYED', productId: 'PRD1', paymentDate: '2026-07-10T09:00:00+09:00' }),
      order({
        orderId: 'O1', productOrderId: 'P2', productOrderStatus: 'PAYED', productId: 'PRD1',
        productClass: '추가구성상품', productOption: '사은품', totalPaymentAmount: 3000,
        paymentDate: '2026-07-10T09:00:00+09:00',
      }),
    ], new Set(), WINDOW);
    expect(parse(r).days['2026-07-10']['54']).toEqual([1, 13000]); // 결제 1건 dedup · 매출은 합산
  });
});

describe('parseFrozenIntradayBuckets — 형식 방어(실패는 degrade)', () => {
  it('정상 JSON 문자열과 Json 객체를 모두 받는다', () => {
    const value = { bv: SNAPSHOT_INTRADAY_BUCKET_VERSION, days: { '2026-07-10': { '54': [1, 10000] } } };
    expect(parseFrozenIntradayBuckets(JSON.stringify(value))).toEqual(value);
    expect(parseFrozenIntradayBuckets(value)).toEqual(value);
  });

  it('null·깨진 JSON·버전 불일치는 null (인트라데이 없음으로 degrade)', () => {
    expect(parseFrozenIntradayBuckets(null)).toBeNull();
    expect(parseFrozenIntradayBuckets('{not json')).toBeNull();
    expect(parseFrozenIntradayBuckets({ bv: 99, days: {} })).toBeNull();
    expect(parseFrozenIntradayBuckets({ bv: SNAPSHOT_INTRADAY_BUCKET_VERSION })).toBeNull();
  });
});

describe('composeIntradayFromFrozen — 읽기 합성(live 경로와 동형)', () => {
  const day = (dateKey: string, buckets: Record<string, [number, number]>): FrozenIntradayBuckets => ({
    bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
    days: { [dateKey]: buckets },
  });

  it('버킷 번호 → KST 기준 시작 시각으로 편다', () => {
    const { points } = composeIntradayFromFrozen([day('2026-07-10', { '54': [2, 20000] })], ['2026-07-10']);
    expect(points).toEqual([
      { startMs: new Date('2026-07-10T09:00:00+09:00').getTime(), orders: 2, revenue: 20000 },
    ]);
  });

  it('그룹(발주 캠페인 여럿)은 같은 칸에서 합산한다', () => {
    const { points } = composeIntradayFromFrozen(
      [day('2026-07-10', { '54': [1, 10000] }), day('2026-07-10', { '54': [2, 5000], '55': [1, 3000] })],
      ['2026-07-10'],
    );
    expect(points.map((p) => [p.orders, p.revenue])).toEqual([[3, 15000], [1, 3000]]);
  });

  it('일별에는 있는데 버킷이 없는 날짜는 daysWithoutBuckets 로 고지한다 (삼키지 않는다)', () => {
    const { points, daysWithoutBuckets } = composeIntradayFromFrozen(
      [day('2026-07-10', { '54': [1, 10000] })],
      ['2026-07-09', '2026-07-10', '2026-07-11'],
    );
    expect(points).toHaveLength(1);
    expect(daysWithoutBuckets).toEqual(['2026-07-09', '2026-07-11']);
  });

  it('범위 밖 버킷 번호는 무시한다(형식 방어)', () => {
    const { points } = composeIntradayFromFrozen([day('2026-07-10', { '144': [9, 9], '-1': [9, 9] })], []);
    expect(points).toEqual([]);
  });
});
