import { describe, expect, it } from "vitest";

import {
  aggregateCoversCampaigns,
  applyPoRequestedSplit,
  composeIntradayFromAggregates,
  composeSalesDetailFromAggregates,
  computeSnapshotDailyAggregate,
  graftIntradayBuckets,
  INTRADAY_BUCKETS_PER_DAY,
  INTRADAY_BUCKET_MINUTES,
  MAX_LIVE_WINDOW_DAYS,
  parseSnapshotDailyAggregate,
  resolveLiveWindowKeys,
  resolveIntradayBucketIndex,
  SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE,
  SNAPSHOT_DAILY_AGGREGATE_VERSION,
  SNAPSHOT_INTRADAY_BUCKET_VERSION,
  UNDATED_DAY_KEY,
} from "./daily-aggregate";
import type { CampaignDayAggregate, SnapshotDailyAggregate } from "./daily-aggregate";
import { computeCampaignSalesDetailForTargets } from "@/lib/mobile-campaign-sales";
import type { PulseOrderLike, PulseSalesCampaignSource } from "@/lib/mobile-pulse-data";

/**
 * 스냅샷 사전 집계(dailyAggregate v1)의 계약 테스트.
 *
 * 최상위 단언은 **기존 블롭 경로(computeCampaignSalesDetailForTargets)와 수치가
 * 완전히 같다**는 것이다 — 이 파일의 parity 테스트가 깨지면 두 경로가 갈라진 것이므로
 * 집계 쪽을 고친다(기대값을 낮추지 말 것). P7 집계 규칙(INVALID_ORDER_STATUSES ·
 * distinct 주문건수 · 클레임 분리)은 양쪽이 같은 SSOT를 재사용한다.
 */

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function makeCampaign(overrides: Partial<PulseSalesCampaignSource> = {}): PulseSalesCampaignSource {
  return {
    id: "camp-1",
    dealName: "콜라겐",
    sellerName: "테스트셀러",
    startMs: ms("2026-07-01T00:00:00+09:00"),
    endMs: ms("2026-07-31T23:59:59+09:00"),
    campaignDealIds: ["cd-1"],
    orderCampaign: {
      id: "oc-1",
      name: "콜라겐",
      productId: "P1",
      mappings: [{ productName: "콜라겐", optionName: null, price: 30000, campaignDealId: "cd-1" }],
    },
    ...overrides,
  };
}

function order(overrides: Partial<PulseOrderLike>): PulseOrderLike {
  return {
    orderId: "O1",
    productOrderId: "PO1",
    productOrderStatus: "PAYED",
    productName: "콜라겐",
    productId: "P1",
    quantity: 1,
    totalPaymentAmount: 30000,
    paymentDate: "2026-07-08T10:00:00+09:00",
    ...overrides,
  };
}

const TODAY = "2026-07-08";

/**
 * 집계 경로 재현 — 쓰기(계산) → JSON 직렬화 왕복 → 읽기(파싱·합성·poRequested 보정).
 * 직렬화를 왕복시키는 이유: 실제 경로는 Json 컬럼을 거치므로 Set/Map이 아니라
 * 배열로 살아남는지까지 검증해야 한다.
 */
function viaAggregate(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  todayKey: string,
  targetCampaignIds: Set<string>,
  poRequestedSet: Set<string> = new Set(),
) {
  const computed = computeSnapshotDailyAggregate(campaigns, orders);
  const roundTripped = parseSnapshotDailyAggregate(JSON.parse(JSON.stringify(computed)));
  expect(roundTripped).not.toBeNull();

  const { detail, poCandidates } = composeSalesDetailFromAggregates(
    [roundTripped!],
    todayKey,
    targetCampaignIds,
  );
  return {
    ...detail,
    statusBreakdown: applyPoRequestedSplit(detail.statusBreakdown, poCandidates, poRequestedSet),
  };
}

/** 두 경로(블롭 vs 집계)가 같은 CampaignSalesDetail을 내는지 대조하고 결과를 돌려준다. */
function expectParity(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  targetCampaignIds: Set<string>,
  poRequestedSet: Set<string> = new Set(),
) {
  const legacy = computeCampaignSalesDetailForTargets(
    campaigns,
    orders,
    TODAY,
    targetCampaignIds,
    poRequestedSet,
  );
  const aggregated = viaAggregate(campaigns, orders, TODAY, targetCampaignIds, poRequestedSet);
  expect(aggregated).toEqual(legacy);
  return legacy;
}

describe("computeSnapshotDailyAggregate ↔ 블롭 경로 수치 동일성(parity)", () => {
  it("distinct 주문건수 — 같은 주문번호 2행 = 주문 1건·수량 2", () => {
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", quantity: 1 }),
      order({ orderId: "A", productOrderId: "A-2", quantity: 1 }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.cumulative.orders).toBe(1);
    expect(detail.cumulative.quantity).toBe(2);
    expect(detail.cumulative.revenue).toBe(60000);
  });

  it("클레임(취소·반품·교환) 제외 + 무효 상태(PAYMENT_WAITING) 제외 + 상태 분포", () => {
    const orders = [
      order({ orderId: "A", productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" }),
      order({ orderId: "B", productOrderStatus: "PAYED", placeOrderStatus: "OK" }),
      order({ orderId: "C", productOrderStatus: "PRODUCT_ORDERED" }),
      order({ orderId: "D", productOrderStatus: "DISPATCH_WAIT" }),
      order({ orderId: "E", productOrderStatus: "DELIVERING" }),
      order({ orderId: "F", productOrderStatus: "DELIVERED" }),
      order({ orderId: "G", productOrderStatus: "CANCELED" }),
      order({ orderId: "H", productOrderStatus: "RETURNED" }),
      order({ orderId: "I", productOrderStatus: "EXCHANGED" }),
      order({ orderId: "J", productOrderStatus: "PAYMENT_WAITING" }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.claims).toEqual({ canceled: 1, returned: 1, exchanged: 1 });
    expect(detail.cumulative.orders).toBe(6); // A~F만 유효
    expect(detail.statusBreakdown).toEqual({
      newOrderBefore: 1,
      newOrderAfter: 3,
      pending: 0,
      shipping: 1,
      completed: 1,
    });
  });

  it("poRequested 보정 — 발주요청 발송분이 배송대기로 이동(집계는 플래그를 굽지 않는다)", () => {
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", productOrderStatus: "PAYED", placeOrderStatus: "OK" }),
      order({ orderId: "B", productOrderId: "B-1", productOrderStatus: "DISPATCH_WAIT" }),
      order({ orderId: "C", productOrderId: "C-1", productOrderStatus: "DELIVERING" }),
      order({ orderId: "D", productOrderId: "D-1", productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" }),
    ];
    const detail = expectParity(
      [makeCampaign()],
      orders,
      new Set(["camp-1"]),
      new Set(["A-1", "B-1", "C-1"]),
    );
    expect(detail.statusBreakdown).toEqual({
      newOrderBefore: 1, // D-1 (발주요청 전)
      newOrderAfter: 0,
      pending: 2, // A-1, B-1
      shipping: 1, // C-1 — 배송중이 배송대기보다 우선(플래그 무관)
      completed: 0,
    });
  });

  it("오늘/누적 분리와 일별 포인트(KST 결제일 기준)", () => {
    const orders = [
      order({ orderId: "A", paymentDate: "2026-07-08T09:00:00+09:00" }),
      order({ orderId: "B", paymentDate: "2026-07-07T09:00:00+09:00" }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.today.orders).toBe(1);
    expect(detail.cumulative.orders).toBe(2);
    expect(detail.daily).toEqual([
      { date: "2026-07-07", orders: 1, revenue: 30000 },
      { date: "2026-07-08", orders: 1, revenue: 30000 },
    ]);
  });

  it("KST 일자 경계 — 자정 직전/직후가 서로 다른 날로 갈린다", () => {
    const orders = [
      order({ orderId: "A", paymentDate: "2026-07-07T23:59:59+09:00" }),
      order({ orderId: "B", paymentDate: "2026-07-08T00:00:00+09:00" }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.daily.map((d) => d.date)).toEqual(["2026-07-07", "2026-07-08"]);
    expect(detail.today.orders).toBe(1);
  });

  it("일자 미상(결제일 부재) 주문은 누적에만 반영되고 daily 포인트를 만들지 않는다", () => {
    const orders = [
      order({ orderId: "A", paymentDate: undefined, orderDate: undefined, orderCreateDate: undefined }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.cumulative.orders).toBe(1);
    expect(detail.daily).toEqual([]);
    expect(detail.today.orders).toBe(0);
  });

  it("클레임만 있는 일자는 daily 포인트를 발행하지 않는다", () => {
    const orders = [
      order({ orderId: "A", productOrderStatus: "CANCELED", paymentDate: "2026-07-06T09:00:00+09:00" }),
      order({ orderId: "B", paymentDate: "2026-07-08T09:00:00+09:00" }),
    ];
    const detail = expectParity([makeCampaign()], orders, new Set(["camp-1"]));
    expect(detail.daily.map((d) => d.date)).toEqual(["2026-07-08"]);
    expect(detail.claims.canceled).toBe(1);
  });

  it("회차(형제) 분리 — 같은 발주 캠페인을 공유해도 날짜 창으로 귀속이 갈린다", () => {
    const round1 = makeCampaign({
      id: "camp-1",
      startMs: ms("2026-07-01T00:00:00+09:00"),
      endMs: ms("2026-07-05T23:59:59+09:00"),
    });
    const round2 = makeCampaign({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      startMs: ms("2026-07-06T00:00:00+09:00"),
      endMs: ms("2026-07-31T23:59:59+09:00"),
    });
    const orders = [
      order({ orderId: "A", paymentDate: "2026-07-03T09:00:00+09:00" }),
      order({ orderId: "B", paymentDate: "2026-07-08T09:00:00+09:00" }),
    ];
    const detail = expectParity([round1, round2], orders, new Set(["camp-2"]));
    expect(detail.cumulative.orders).toBe(1); // B만 2차 회차
  });

  it("그룹(조합) 합성 — 한 주문이 멤버 여럿에 걸쳐도 union으로 1건", () => {
    const memberA = makeCampaign({ id: "camp-1", campaignDealIds: ["cd-1"] });
    const memberB = makeCampaign({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      orderCampaign: {
        id: "oc-2",
        name: "비타민",
        productId: "P2",
        mappings: [{ productName: "비타민", optionName: null, price: 20000, campaignDealId: "cd-2" }],
      },
    });
    const orders = [
      order({ orderId: "SHARED", productOrderId: "S-1", productName: "콜라겐", productId: "P1" }),
      order({
        orderId: "SHARED",
        productOrderId: "S-2",
        productName: "비타민",
        productId: "P2",
        totalPaymentAmount: 20000,
      }),
    ];
    const detail = expectParity([memberA, memberB], orders, new Set(["camp-1", "camp-2"]));
    expect(detail.cumulative.orders).toBe(1); // 같은 결제 = 1건
    expect(detail.cumulative.revenue).toBe(50000);
    expect(detail.daily).toEqual([{ date: "2026-07-08", orders: 1, revenue: 50000 }]);
  });

  it("품목별(상품·옵션) 집계 — 매출 내림차순·distinct 주문건수", () => {
    const campaign = makeCampaign({
      orderCampaign: {
        id: "oc-1",
        name: "콜라겐",
        productId: "P1",
        mappings: [
          { productName: "콜라겐", optionName: "1박스", price: 30000, campaignDealId: "cd-1" },
          { productName: "콜라겐", optionName: "3박스", price: 80000, campaignDealId: "cd-1" },
        ],
      },
    });
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", productOption: "1박스", totalPaymentAmount: 30000 }),
      order({ orderId: "B", productOrderId: "B-1", productOption: "3박스", totalPaymentAmount: 80000 }),
    ];
    const detail = expectParity([campaign], orders, new Set(["camp-1"]));
    expect(detail.items).toEqual([
      { name: "콜라겐 · 3박스", orders: 1, quantity: 1, revenue: 80000 },
      { name: "콜라겐 · 1박스", orders: 1, quantity: 1, revenue: 30000 },
    ]);
  });

  it("매칭 주문이 없으면 전부 0", () => {
    const detail = expectParity([makeCampaign()], [], new Set(["camp-1"]));
    expect(detail.cumulative).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(detail.items).toEqual([]);
  });
});

describe("집계 형태·버전 계약", () => {
  it("v=1과 참여 캠페인 전수(campaignIds)를 함께 기록한다", () => {
    const aggregate = computeSnapshotDailyAggregate(
      [makeCampaign(), makeCampaign({ id: "camp-2", campaignDealIds: ["cd-2"] })],
      [order({ orderId: "A" })],
    );
    expect(aggregate.v).toBe(SNAPSHOT_DAILY_AGGREGATE_VERSION);
    expect(aggregate.campaignIds).toEqual(["camp-1", "camp-2"]);
    expect(Object.keys(aggregate.days)).toEqual([TODAY]);
  });

  it("일자 미상 주문은 UNDATED_DAY_KEY 리프에 들어간다", () => {
    const aggregate = computeSnapshotDailyAggregate(
      [makeCampaign()],
      [order({ orderId: "A", paymentDate: undefined })],
    );
    expect(Object.keys(aggregate.days)).toEqual([UNDATED_DAY_KEY]);
  });

  it("parseSnapshotDailyAggregate: 버전 불일치·손상·마커는 null(→ 블롭 폴백)", () => {
    expect(parseSnapshotDailyAggregate(null)).toBeNull();
    expect(parseSnapshotDailyAggregate(undefined)).toBeNull();
    expect(parseSnapshotDailyAggregate("not json")).toBeNull();
    expect(parseSnapshotDailyAggregate(SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE)).toBeNull();
    expect(parseSnapshotDailyAggregate({ v: 2, campaignIds: [], days: {} })).toBeNull();
    expect(parseSnapshotDailyAggregate({ v: 1, days: {} })).toBeNull(); // campaignIds 없음
  });

  it("parseSnapshotDailyAggregate: SQLite 문자열 컬럼도 파싱한다", () => {
    const aggregate = computeSnapshotDailyAggregate([makeCampaign()], [order({ orderId: "A" })]);
    const parsed = parseSnapshotDailyAggregate(JSON.stringify(aggregate));
    expect(parsed?.campaignIds).toEqual(["camp-1"]);
  });

  it("aggregateCoversCampaigns: 집계 이후 신설·연동된 캠페인은 미커버로 판정된다", () => {
    const aggregate = computeSnapshotDailyAggregate([makeCampaign()], []);
    expect(aggregateCoversCampaigns(aggregate, new Set(["camp-1"]))).toBe(true);
    expect(aggregateCoversCampaigns(aggregate, new Set(["camp-1", "camp-new"]))).toBe(false);
  });
});

describe("composeSalesDetailFromAggregates — 여러 스냅샷 행(일자) 합성", () => {
  it("일별 집계 행들을 합쳐도 블롭 전량 계산과 동일하다(창 distinct = 일별 distinct 합)", () => {
    const campaigns = [makeCampaign()];
    const day6 = [order({ orderId: "A", productOrderId: "A-1", paymentDate: "2026-07-06T09:00:00+09:00" })];
    const day7 = [
      order({ orderId: "B", productOrderId: "B-1", paymentDate: "2026-07-07T09:00:00+09:00" }),
      order({ orderId: "B", productOrderId: "B-2", paymentDate: "2026-07-07T10:00:00+09:00" }),
    ];
    const day8 = [order({ orderId: "C", productOrderId: "C-1", paymentDate: "2026-07-08T09:00:00+09:00" })];

    // 실제 경로: 스냅샷 1행(=1일)마다 집계가 따로 저장된다.
    const perDayAggregates = [day6, day7, day8].map((orders) =>
      computeSnapshotDailyAggregate(campaigns, orders),
    );
    const composed = composeSalesDetailFromAggregates(
      perDayAggregates,
      TODAY,
      new Set(["camp-1"]),
    ).detail;

    const legacy = computeCampaignSalesDetailForTargets(
      campaigns,
      [...day6, ...day7, ...day8],
      TODAY,
      new Set(["camp-1"]),
    );
    expect(composed).toEqual(legacy);
    expect(composed.cumulative.orders).toBe(3); // A·B(2라인 1건)·C
    expect(composed.today).toEqual({ orders: 1, quantity: 1, revenue: 30000 });
  });
});

describe("인트라데이 버킷 — 쓰기(계산·직렬화)", () => {
  it("버킷 번호는 KST 자정 기준 10분 칸이다(00:00→0 · 10:00→60 · 23:59→143)", () => {
    expect(INTRADAY_BUCKET_MINUTES).toBe(10);
    expect(INTRADAY_BUCKETS_PER_DAY).toBe(144);
    expect(resolveIntradayBucketIndex(order({ paymentDate: "2026-07-08T00:00:00+09:00" }))).toBe(0);
    expect(resolveIntradayBucketIndex(order({ paymentDate: "2026-07-08T00:09:59+09:00" }))).toBe(0);
    expect(resolveIntradayBucketIndex(order({ paymentDate: "2026-07-08T00:10:00+09:00" }))).toBe(1);
    expect(resolveIntradayBucketIndex(order({ paymentDate: "2026-07-08T10:00:00+09:00" }))).toBe(60);
    expect(resolveIntradayBucketIndex(order({ paymentDate: "2026-07-08T23:59:59+09:00" }))).toBe(143);
  });

  it("시각이 없는 주문은 버킷도 없다(일자미상과 같은 취급)", () => {
    expect(
      resolveIntradayBucketIndex({ ...order({}), paymentDate: undefined, orderDate: undefined, orderCreateDate: undefined }),
    ).toBeNull();
  });

  it("bv 마커를 함께 기록한다 — v는 올리지 않는다(구 행이 블롭 폴백을 타지 않게)", () => {
    const computed = computeSnapshotDailyAggregate([makeCampaign()], [order({})]);
    expect(computed.v).toBe(SNAPSHOT_DAILY_AGGREGATE_VERSION);
    expect(computed.bv).toBe(SNAPSHOT_INTRADAY_BUCKET_VERSION);
  });

  it("버킷은 희소하다 — 주문이 찍힌 칸만 담고 빈 칸은 넣지 않는다", () => {
    const computed = computeSnapshotDailyAggregate(
      [makeCampaign()],
      [
        order({ orderId: "A", productOrderId: "PA", paymentDate: "2026-07-08T09:03:00+09:00" }),
        order({ orderId: "B", productOrderId: "PB", paymentDate: "2026-07-08T21:47:00+09:00" }),
      ],
    );
    const buckets = computed.days["2026-07-08"]["camp-1"].buckets!;
    expect(Object.keys(buckets).sort((a, b) => Number(a) - Number(b))).toEqual(["54", "130"]);
  });

  it("버킷 주문 합 = 그날 일별 주문(같은 시각 원천을 쓰므로 등식이 성립한다)", () => {
    const orders = [
      // 같은 결제(2라인)는 한 칸에서 1건으로 센다.
      order({ orderId: "A", productOrderId: "PA1", paymentDate: "2026-07-08T11:00:00+09:00" }),
      order({ orderId: "A", productOrderId: "PA2", paymentDate: "2026-07-08T11:00:00+09:00" }),
      order({ orderId: "B", productOrderId: "PB", paymentDate: "2026-07-08T11:05:00+09:00" }),
      order({ orderId: "C", productOrderId: "PC", paymentDate: "2026-07-08T18:20:00+09:00" }),
    ];
    const computed = computeSnapshotDailyAggregate([makeCampaign()], orders);
    const leaf = computed.days["2026-07-08"]["camp-1"];
    const bucketOrders = Object.values(leaf.buckets!).reduce((sum, [n]) => sum + n, 0);
    expect(bucketOrders).toBe(leaf.orderKeys.length);
    expect(bucketOrders).toBe(3); // A(2라인=1건) · B · C

    const detail = viaAggregate([makeCampaign()], orders, TODAY, new Set(["camp-1"]));
    expect(detail.daily.find((d) => d.date === "2026-07-08")!.orders).toBe(bucketOrders);
  });

  it("버킷 매출 합 = 그날 리프 매출", () => {
    const orders = [
      order({ orderId: "A", productOrderId: "PA", paymentDate: "2026-07-08T11:00:00+09:00" }),
      order({ orderId: "B", productOrderId: "PB", paymentDate: "2026-07-08T18:00:00+09:00" }),
    ];
    const leaf = computeSnapshotDailyAggregate([makeCampaign()], orders).days["2026-07-08"]["camp-1"];
    const bucketRevenue = Object.values(leaf.buckets!).reduce((sum, [, r]) => sum + r, 0);
    expect(bucketRevenue).toBe(leaf.revenue);
  });

  it("클레임·무효 상태는 버킷에 들어가지 않는다(유효 주문만)", () => {
    const computed = computeSnapshotDailyAggregate(
      [makeCampaign()],
      [
        order({ orderId: "A", productOrderId: "PA", productOrderStatus: "CANCELED" }),
        order({ orderId: "B", productOrderId: "PB", productOrderStatus: "PAYMENT_WAITING" }),
      ],
    );
    const leaf = computed.days["2026-07-08"]["camp-1"];
    expect(leaf.buckets).toEqual({});
  });
});

describe("composeIntradayFromAggregates — 읽기(합성·degrade)", () => {
  const campaigns = [makeCampaign()];

  it("버킷 시각 오름차순으로 점을 만들고 시각은 KST 자정 + 칸×10분이다", () => {
    const aggregate = computeSnapshotDailyAggregate(campaigns, [
      order({ orderId: "A", productOrderId: "PA", paymentDate: "2026-07-08T18:20:00+09:00" }),
      order({ orderId: "B", productOrderId: "PB", paymentDate: "2026-07-08T09:00:00+09:00" }),
    ]);
    const { points } = composeIntradayFromAggregates([aggregate], new Set(["camp-1"]));
    expect(points).toHaveLength(2);
    expect(points[0].startMs).toBe(new Date("2026-07-08T09:00:00+09:00").getTime());
    expect(points[1].startMs).toBe(new Date("2026-07-08T18:20:00+09:00").getTime());
    expect(points.map((p) => p.orders)).toEqual([1, 1]);
  });

  it("스코프 밖 캠페인의 버킷은 섞이지 않는다", () => {
    const aggregate = computeSnapshotDailyAggregate(campaigns, [
      order({ orderId: "A", productOrderId: "PA", paymentDate: "2026-07-08T09:00:00+09:00" }),
    ]);
    // 귀속된 캠페인(리프의 실제 키)으로 스코프를 잡으면 점이 나오고, 무관한 id 면 안 나온다.
    const ownerId = Object.keys(aggregate.days["2026-07-08"])[0];
    expect(composeIntradayFromAggregates([aggregate], new Set([ownerId])).points).toHaveLength(1);
    expect(composeIntradayFromAggregates([aggregate], new Set(["camp-none"])).points).toEqual([]);
  });

  it("일자미상(UNDATED) 리프는 시각이 없으므로 점을 만들지 않는다", () => {
    const aggregate = computeSnapshotDailyAggregate(campaigns, [
      {
        ...order({}),
        paymentDate: undefined,
        orderDate: undefined,
        orderCreateDate: undefined,
      },
    ]);
    expect(aggregate.days[UNDATED_DAY_KEY]).toBeDefined();
    expect(composeIntradayFromAggregates([aggregate], new Set(["camp-1"])).points).toEqual([]);
  });

  it("버킷이 없는 구 집계 행은 그 날짜를 daysWithoutBuckets 로 표면화한다(주문 0인 날과 구분)", () => {
    const legacy = computeSnapshotDailyAggregate(campaigns, [order({})]);
    // 구 집계 재현 — bv 마커와 리프 buckets 를 걷어낸다.
    delete legacy.bv;
    for (const byCampaign of Object.values(legacy.days)) {
      for (const leaf of Object.values(byCampaign)) delete leaf.buckets;
    }
    const composed = composeIntradayFromAggregates([legacy], new Set(["camp-1"]));
    expect(composed.points).toEqual([]);
    expect(composed.daysWithoutBuckets).toEqual(["2026-07-08"]);
  });

  it("구 집계도 parse 는 통과한다 — 인트라데이만 degrade 하고 블롭 폴백을 트리거하지 않는다", () => {
    const legacy = computeSnapshotDailyAggregate(campaigns, [order({})]);
    delete legacy.bv;
    const parsed = parseSnapshotDailyAggregate(JSON.parse(JSON.stringify(legacy)));
    expect(parsed).not.toBeNull();
    expect(parsed!.bv).toBeUndefined();
  });

  it("여러 날짜 행을 합쳐도 시각 순서가 유지된다", () => {
    const day7 = computeSnapshotDailyAggregate(campaigns, [
      order({ orderId: "A", productOrderId: "PA", paymentDate: "2026-07-07T20:00:00+09:00" }),
    ]);
    const day8 = computeSnapshotDailyAggregate(campaigns, [
      order({ orderId: "B", productOrderId: "PB", paymentDate: "2026-07-08T08:00:00+09:00" }),
    ]);
    const { points } = composeIntradayFromAggregates([day8, day7], new Set(["camp-1"]));
    expect(points.map((p) => new Date(p.startMs).toISOString())).toEqual([
      new Date("2026-07-07T20:00:00+09:00").toISOString(),
      new Date("2026-07-08T08:00:00+09:00").toISOString(),
    ]);
  });
});

/**
 * 버킷 이식(graftIntradayBuckets)의 계약 — **순수 가산**이다.
 *
 * 이 테스트가 지키는 것은 "인트라데이를 얻는다"가 아니라 **"얻는 과정에서 아무것도 잃지
 * 않는다"** 이다. 백필은 프로덕션 스냅샷을 덮어쓰므로, 리프 하나가 조용히 사라지거나
 * 멤버십 가드가 넓어지는 것은 되돌릴 수 없는 손실이다(둘 다 화면에서는 "주문이 줄었다"로만
 * 보여 원인 추적이 불가능하다).
 */
describe("graftIntradayBuckets", () => {
  const leaf = (orderKeys: string[], extra: Partial<CampaignDayAggregate> = {}): CampaignDayAggregate => ({
    orderKeys,
    validLines: orderKeys.length,
    quantity: orderKeys.length,
    revenue: orderKeys.length * 10000,
    statusBreakdown: { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0 },
    poCandidates: { newBefore: [], newAfter: [], other: [] },
    claims: { canceled: 0, returned: 0, exchanged: 0 },
    items: [],
    ...extra,
  });

  const previous: SnapshotDailyAggregate = {
    v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
    campaignIds: ["active-1", "closed-1"],
    days: {
      "2026-07-13": {
        "active-1": leaf(["O1", "O2"]),
        // 그 사이 마감돼 재계산 우주에서 사라지는 캠페인.
        "closed-1": leaf(["O9"]),
      },
    },
  };

  it("마감 캠페인 리프를 보존한 채 활성 캠페인만 버킷을 받는다", () => {
    const recomputed: SnapshotDailyAggregate = {
      v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
      bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
      campaignIds: ["active-1"],
      days: { "2026-07-13": { "active-1": leaf(["O1", "O2"], { buckets: { "60": [2, 20000] } }) } },
    };

    const { merged, grafted, mismatched } = graftIntradayBuckets(previous, recomputed);

    expect(grafted).toBe(1);
    expect(mismatched).toBe(0);
    expect(merged.bv).toBe(SNAPSHOT_INTRADAY_BUCKET_VERSION);
    expect(merged.days["2026-07-13"]["active-1"].buckets).toEqual({ "60": [2, 20000] });
    // 종전 구현이 행 전체를 건너뛰게 만들던 바로 그 리프 — 값이 한 글자도 변하지 않아야 한다.
    expect(merged.days["2026-07-13"]["closed-1"]).toEqual(previous.days["2026-07-13"]["closed-1"]);
  });

  it("귀속이 달라진 리프(orderKeys 불일치)에는 버킷을 붙이지 않는다", () => {
    // 우주 변화로 라인을 하나 더 주운 재계산 — 버킷 합이 기존 일별 값과 어긋난다.
    const recomputed: SnapshotDailyAggregate = {
      v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
      bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
      campaignIds: ["active-1"],
      days: {
        "2026-07-13": { "active-1": leaf(["O1", "O2", "O3"], { buckets: { "60": [3, 30000] } }) },
      },
    };

    const { merged, grafted, mismatched } = graftIntradayBuckets(previous, recomputed);

    expect(grafted).toBe(0);
    expect(mismatched).toBe(1);
    // 이식이 하나도 없으면 bv 를 켜지 않는다 — 다음 실행이 이 행을 다시 대상으로 잡아야 한다.
    expect(merged.bv).toBeUndefined();
    expect(merged.days["2026-07-13"]["active-1"].buckets).toBeUndefined();
    expect(merged.days["2026-07-13"]["active-1"].orderKeys).toEqual(["O1", "O2"]);
  });

  it("campaignIds 를 넓히지 않는다 — 멤버십 가드가 신설 캠페인을 0건으로 은폐하면 안 된다", () => {
    const recomputed: SnapshotDailyAggregate = {
      v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
      bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
      campaignIds: ["active-1", "new-after-snapshot"],
      days: { "2026-07-13": { "active-1": leaf(["O1", "O2"], { buckets: { "60": [2, 20000] } }) } },
    };

    const { merged } = graftIntradayBuckets(previous, recomputed);

    expect(merged.campaignIds).toEqual(["active-1", "closed-1"]);
    expect(aggregateCoversCampaigns(merged, new Set(["new-after-snapshot"]))).toBe(false);
  });

  it("리프를 새로 만들지 않는다 — 재계산에만 있는 리프는 무시한다", () => {
    const recomputed: SnapshotDailyAggregate = {
      v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
      bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
      campaignIds: ["active-1", "new-after-snapshot"],
      days: {
        "2026-07-13": {
          "active-1": leaf(["O1", "O2"], { buckets: { "60": [2, 20000] } }),
          "new-after-snapshot": leaf(["O7"], { buckets: { "12": [1, 10000] } }),
        },
      },
    };

    const { merged } = graftIntradayBuckets(previous, recomputed);

    expect(Object.keys(merged.days["2026-07-13"]).sort()).toEqual(["active-1", "closed-1"]);
  });
});

/**
 * 조회 창 결정 SSOT — **시간이 지나야 드러나는 결함**이라 시점 고정 테스트가 유일한 방어선이다.
 *
 * 종전 구현은 창의 시작을 `now − 30일`로 **하한**했다. 캠페인 시작일은 고정인데 하한은 매일
 * 전진하므로, 시작 후 30일이 지나는 순간부터 캠페인 초반 날짜가 하루에 하나씩 조회 밖으로
 * 밀려나 집계가 조용히 줄었다. 아래 테스트는 `now` 만 미래로 옮겨 그 회귀를 고정한다.
 */
describe("resolveLiveWindowKeys — 조회 창은 시간이 지나도 캠페인 시작을 놓치지 않는다", () => {
  const startMs = new Date("2026-07-13T00:00:00+09:00").getTime();

  it("now 를 미래로 옮겨도 조회 시작은 캠페인 시작일에 고정된다", () => {
    for (const nowIso of [
      "2026-07-20T12:00:00+09:00", // 시작 +7일
      "2026-08-13T12:00:00+09:00", // 시작 +31일 — 종전 구현이 갉기 시작하던 지점
      "2026-08-20T12:00:00+09:00", // 시작 +38일
      "2026-10-10T12:00:00+09:00", // 시작 +89일 — 절대 상한 직전
    ]) {
      const window = resolveLiveWindowKeys(startMs, new Date(nowIso), "test");
      expect(window.startKey).toBe("2026-07-13");
      expect(window.truncated).toBe(false);
    }
  });

  it("todayKey 는 KST 기준 오늘이다", () => {
    // 09:00 KST = 00:00 UTC — UTC 로 자르면 하루 전 날짜가 나온다.
    const window = resolveLiveWindowKeys(startMs, new Date("2026-07-20T00:30:00+09:00"), "test");
    expect(window.todayKey).toBe("2026-07-20");
  });

  it("절대 상한(폭주 가드)을 넘으면 잘리고, 그 사실을 truncated 로 고지한다", () => {
    const now = new Date("2026-12-31T12:00:00+09:00"); // 시작 +171일
    const window = resolveLiveWindowKeys(startMs, now, "test");
    expect(window.truncated).toBe(true);
    // 잘린 시작은 now − MAX_LIVE_WINDOW_DAYS
    const guardMs = now.getTime() - MAX_LIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(window.startKey).toBe(
      new Date(guardMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
  });

  it("절대 상한은 30일보다 커야 한다 — 캠페인 최대 길이를 덮지 못하면 결함이 되살아난다", () => {
    expect(MAX_LIVE_WINDOW_DAYS).toBeGreaterThan(30);
  });

  it("시작일 불명(NaN)이면 상한 창으로 떨어지되 잘렸다고 말하지 않는다(모름 ≠ 절단)", () => {
    const window = resolveLiveWindowKeys(NaN, new Date("2026-07-20T12:00:00+09:00"), "test");
    expect(window.truncated).toBe(false);
    expect(window.startKey).toBe("2026-04-21");
  });
});
