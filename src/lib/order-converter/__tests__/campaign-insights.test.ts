import { describe, it, expect } from 'vitest';
import {
  createInsightAccumulator,
  trackOrderInsight,
  trackClaimInsight,
  buildCampaignInsights,
} from '../campaign-insights';

function order(overrides: Record<string, unknown> = {}) {
  return {
    inflowPath: '마케팅링크',
    payLocationType: 'MOBILE',
    paymentMeans: '신용카드 간편결제',
    isMembershipSubscribed: false,
    ordererNo: '1001',
    ...overrides,
  };
}

describe('campaign-insights', () => {
  it('유입경로·기기·결제수단·멤버십·구매자 버킷을 결제 단위로 집계한다', () => {
    const acc = createInsightAccumulator();
    trackOrderInsight(acc, order(), 2, 50000, '2026-07-06T23:59:50.081+09:00', '2001');
    trackOrderInsight(acc, order({ inflowPath: '네이버쇼핑', payLocationType: 'PC', ordererNo: '1002', isMembershipSubscribed: true }), 1, 30000, '2026-07-07T00:10:00.000+09:00', '2002');
    trackOrderInsight(acc, order({ ordererNo: '1001' }), 1, 20000, '2026-07-07T20:30:00.000+09:00', '2003');

    const insights = buildCampaignInsights(acc, 3);

    // 유입: 마케팅링크 2건(70,000원), 네이버쇼핑 1건 — 주문수 내림차순 정렬
    expect(insights.inflow[0]).toMatchObject({ path: '마케팅링크', orders: 2, quantity: 3, revenue: 70000 });
    expect(insights.inflow[1].path).toBe('네이버쇼핑');
    expect(insights.inflow[0].orderRatio).toBeCloseTo((2 / 3) * 100);

    // 시간대: KST 기준 23시 1건, 0시 1건, 20시 1건 (UTC로 밀리면 안 됨)
    const byHour = Object.fromEntries(insights.hourly.map((h) => [h.hour, h.orders]));
    expect(byHour[23]).toBe(1);
    expect(byHour[0]).toBe(1);
    expect(byHour[20]).toBe(1);
    expect(insights.hourly.reduce((s, h) => s + h.orders, 0)).toBe(3);

    expect(insights.device).toMatchObject({ mobile: 2, pc: 1, unknown: 0 });
    expect(insights.paymentMeans[0]).toMatchObject({ means: '신용카드 간편결제', orders: 3 });
    expect(insights.membership).toMatchObject({ orders: 1 });

    // 구매자: 1001은 2건(반복), 1002는 1건 → unique 2, repeat 1
    expect(insights.buyers).toMatchObject({ unique: 2, repeat: 1 });
    expect(insights.buyers.repeatRatio).toBeCloseTo(50);
  });

  it('inflowPath 누락은 기타/미상으로, 시각 파싱 실패는 시간대 집계에서 제외한다', () => {
    const acc = createInsightAccumulator();
    trackOrderInsight(acc, order({ inflowPath: undefined, payLocationType: undefined, paymentMeans: undefined, ordererNo: undefined }), 1, 10000, 'not-a-date', '3001');

    const insights = buildCampaignInsights(acc, 1);
    expect(insights.inflow[0].path).toBe('기타/미상');
    expect(insights.hourly.reduce((s, h) => s + h.orders, 0)).toBe(0);
    expect(insights.device.unknown).toBe(1);
    expect(insights.paymentMeans).toHaveLength(0);
    expect(insights.buyers.unique).toBe(0);
  });

  it('한 결제의 여러 상품주문 라인은 주문 1건으로 세되 수량·매출은 라인 합으로 누적한다', () => {
    const acc = createInsightAccumulator();
    // 같은 orderId 'A'의 상품주문 라인 3개 + 다른 결제 'B' 1개.
    trackOrderInsight(acc, order({ ordererNo: '1001' }), 2, 30000, '2026-07-07T10:00:00.000+09:00', 'A');
    trackOrderInsight(acc, order({ ordererNo: '1001' }), 1, 15000, '2026-07-07T10:00:00.000+09:00', 'A');
    trackOrderInsight(acc, order({ ordererNo: '1001' }), 3, 45000, '2026-07-07T10:00:00.000+09:00', 'A');
    trackOrderInsight(acc, order({ ordererNo: '1002' }), 1, 10000, '2026-07-07T11:00:00.000+09:00', 'B');

    const insights = buildCampaignInsights(acc, 2); // distinctOrderCount = 2 (A, B)

    // 마케팅링크: 주문 2건(결제 단위)이지만 수량 7개·매출 100,000원(라인 합)
    expect(insights.inflow[0]).toMatchObject({ path: '마케팅링크', orders: 2, quantity: 7, revenue: 100000 });
    // 결제수단·기기·시간대(10시)도 결제 단위 — A의 3라인이 1건으로만 반영
    expect(insights.paymentMeans[0]).toMatchObject({ orders: 2 });
    expect(insights.device.mobile).toBe(2);
    expect(insights.hourly.find((h) => h.hour === 10)?.orders).toBe(1);
    // 구매자 1001은 결제 1건(A)뿐이라 반복구매 아님 — 라인 3개를 반복으로 오분류하지 않는다
    expect(insights.buyers).toMatchObject({ unique: 2, repeat: 0 });
  });

  it('클레임은 결제(orderId) 단위로 dedup한다 — 같은 주문의 여러 취소 라인은 1건', () => {
    const acc = createInsightAccumulator();
    trackClaimInsight(acc, 'C1', 'CANCELED');
    trackClaimInsight(acc, 'C1', 'CANCELED'); // 같은 주문의 두 번째 취소 라인 → 무시
    trackClaimInsight(acc, 'C2', 'RETURNED');
    trackClaimInsight(acc, 'C3', 'EXCHANGED');
    trackClaimInsight(acc, 'C4', 'PAYMENT_WAITING'); // 클레임 아님 → 무시

    const insights = buildCampaignInsights(acc, 10);
    expect(insights.claims).toMatchObject({ canceled: 1, returned: 1, exchanged: 1, total: 3 });
  });

  it('클레임 비율은 (유효주문+클레임) 분모로 계산한다', () => {
    const acc = createInsightAccumulator();
    acc.claims.canceled = 2;
    acc.claims.returned = 1;

    const insights = buildCampaignInsights(acc, 97);
    expect(insights.claims.total).toBe(3);
    expect(insights.claims.ratio).toBeCloseTo(3);
  });

  it('주문 0건이어도 비율 계산이 NaN 없이 0으로 떨어진다', () => {
    const insights = buildCampaignInsights(createInsightAccumulator(), 0);
    expect(insights.membership.ratio).toBe(0);
    expect(insights.buyers.repeatRatio).toBe(0);
    expect(insights.claims.ratio).toBe(0);
  });
});
