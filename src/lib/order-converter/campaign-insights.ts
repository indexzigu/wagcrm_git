// 캠페인 인사이트(비식별 집계) 버킷. 스냅샷에 이미 저장되던 분석성 필드
// (inflowPath·payLocationType·paymentMeans·isMembershipSubscribed·ordererNo·클레임 상태)를
// campaigns route의 기존 집계 순회에 얹어 캠페인 단위로 모은다. ordererNo는 서버 내부
// dedup에만 쓰고 응답에는 개수만 내보낸다(구매자 식별자/PII 미노출).
//
// 주문 카운트 계약(오너 확정, docs/agents/data-contracts.md): "주문 N건"은 결제(orderId)
// distinct 기준이다. 순회는 상품주문 라인 단위로 돌지만, 이 파일의 모든 orders 계열 카운터는
// 결제 단위여야 하므로 한 결제의 여러 라인을 1건으로만 센다. 유입경로·시간대·결제수단·멤버십·
// 구매자 카운트는 전부 결제 헤더에서 상속되는 속성이라(같은 orderId의 라인들은 값이 동일)
// "그 orderId의 첫 라인일 때만 카운트" 게이트 하나로 전 차원을 결제 단위로 만든다.
// 단 quantity·revenue는 라인마다 실제 누적한다(수량·매출은 라인 합이 정답).

export type InsightAccumulator = ReturnType<typeof createInsightAccumulator>;

export function createInsightAccumulator() {
  return {
    inflow: {} as Record<string, { orders: number; quantity: number; revenue: number }>,
    hourly: Array.from({ length: 24 }, () => ({ orders: 0, revenue: 0 })),
    device: { mobile: 0, pc: 0, unknown: 0 },
    paymentMeans: {} as Record<string, number>,
    membershipOrders: 0,
    buyerOrderCounts: {} as Record<string, number>,
    claims: { canceled: 0, returned: 0, exchanged: 0 },
    // 결제 단위 dedup 상태(응답에는 나가지 않는 내부 필드). _seenOrderKeys는 유효주문 orders
    // 계열 게이트용, _seenClaimKeys는 "status:orderKey" 기준 클레임 중복 제거용.
    _seenOrderKeys: new Set<string>(),
    _seenClaimKeys: new Set<string>(),
  };
}

// 유효 주문의 상품주문 라인 1개를 인사이트 버킷에 반영한다(dailyMap 유효 집계와 동일 기준·동일
// 호출 지점). orderKey는 resolveOrderCountKey(order)의 결제 distinct 키 — 빈 문자열이면(주문번호·
// 상품주문번호 모두 없음) dedup 불가로 라인을 각각 1건으로 폴백한다(distinctOrderCount와 동일 취급).
export function trackOrderInsight(
  acc: InsightAccumulator,
  order: any,
  qty: number,
  revenue: number,
  orderTimeStr: string | undefined,
  orderKey: string
) {
  // 이 라인이 속한 결제의 첫 라인인가 — 주문 단위 카운터는 여기서만 증가시킨다.
  const firstLine = orderKey ? !acc._seenOrderKeys.has(orderKey) : true;
  if (orderKey) acc._seenOrderKeys.add(orderKey);

  const path = (order.inflowPath || '').trim() || '기타/미상';
  if (!acc.inflow[path]) acc.inflow[path] = { orders: 0, quantity: 0, revenue: 0 };
  if (firstLine) acc.inflow[path].orders++;
  acc.inflow[path].quantity += qty;
  acc.inflow[path].revenue += revenue;

  if (orderTimeStr) {
    const t = new Date(orderTimeStr);
    if (!isNaN(t.getTime())) {
      const hour = new Date(t.getTime() + 9 * 60 * 60 * 1000).getUTCHours(); // KST 시각
      if (firstLine) acc.hourly[hour].orders++;
      acc.hourly[hour].revenue += revenue;
    }
  }

  // 결제 단위 카운터(같은 orderId의 추가 라인에서는 재집계하지 않는다).
  if (firstLine) {
    if (order.payLocationType === 'MOBILE') acc.device.mobile++;
    else if (order.payLocationType === 'PC') acc.device.pc++;
    else acc.device.unknown++;

    const means = (order.paymentMeans || '').trim();
    if (means) acc.paymentMeans[means] = (acc.paymentMeans[means] || 0) + 1;

    if (order.isMembershipSubscribed === true) acc.membershipOrders++;

    const buyerKey = order.ordererNo || order.ordererId;
    if (buyerKey) acc.buyerOrderCounts[String(buyerKey)] = (acc.buyerOrderCounts[String(buyerKey)] || 0) + 1;
  }
}

// 취소·반품·교환 주문 1건을 결제(orderId) 단위로 집계한다. 유효주문 분기 밖(무효 상태)에서
// 호출되므로 trackOrderInsight의 dedup과 분리된 _seenClaimKeys를 쓴다. 같은 결제의 여러 취소
// 라인은 1건으로만 센다("status:orderKey" 키라 한 주문이 취소+반품 라인을 섞어 가진 드문 경우는
// 유형별로 1건씩 유지된다). orderKey가 빈 문자열이면 dedup 불가로 라인을 각각 센다.
export function trackClaimInsight(acc: InsightAccumulator, orderKey: string, status: string) {
  const type =
    status === 'CANCELED' ? 'canceled' : status === 'RETURNED' ? 'returned' : status === 'EXCHANGED' ? 'exchanged' : null;
  if (!type) return;
  const dedupKey = orderKey ? `${status}:${orderKey}` : '';
  if (dedupKey) {
    if (acc._seenClaimKeys.has(dedupKey)) return;
    acc._seenClaimKeys.add(dedupKey);
  }
  acc.claims[type]++;
}

// orderCount는 결제 distinct 기준 주문건수(validOrderKeys.size)여야 한다 — 누적기의 orders 계열이
// 결제 단위로 집계되므로 비율 분모도 결제 단위로 맞춰 numerator/denominator 단위를 일치시킨다.
export function buildCampaignInsights(acc: InsightAccumulator, orderCount: number) {
  const inflow = Object.entries(acc.inflow)
    .map(([path, v]) => ({
      path,
      orders: v.orders,
      quantity: v.quantity,
      revenue: v.revenue,
      orderRatio: orderCount > 0 ? (v.orders / orderCount) * 100 : 0,
    }))
    .sort((a, b) => b.orders - a.orders);
  const buyerCounts = Object.values(acc.buyerOrderCounts);
  const uniqueBuyers = buyerCounts.length;
  // ponytail: 반복구매는 캠페인 내 동일 구매자의 결제(주문) 2건+만 집계(라인수 아님 — buyerOrderCounts가
  // 결제 단위로 증가). 회차간(크로스캠페인) 재구매는 과거 스냅샷 전범위 통합 집계가 필요해 별도 단계로 미룬다.
  const repeatBuyers = buyerCounts.filter((n) => n >= 2).length;
  const claimTotal = acc.claims.canceled + acc.claims.returned + acc.claims.exchanged;
  return {
    inflow,
    hourly: acc.hourly.map((h, hour) => ({ hour, orders: h.orders, revenue: h.revenue })),
    device: acc.device,
    paymentMeans: Object.entries(acc.paymentMeans)
      .map(([means, orders]) => ({ means, orders }))
      .sort((a, b) => b.orders - a.orders),
    membership: {
      orders: acc.membershipOrders,
      ratio: orderCount > 0 ? (acc.membershipOrders / orderCount) * 100 : 0,
    },
    buyers: {
      unique: uniqueBuyers,
      repeat: repeatBuyers,
      repeatRatio: uniqueBuyers > 0 ? (repeatBuyers / uniqueBuyers) * 100 : 0,
    },
    claims: {
      ...acc.claims,
      total: claimTotal,
      ratio: orderCount + claimTotal > 0 ? (claimTotal / (orderCount + claimTotal)) * 100 : 0,
    },
  };
}
