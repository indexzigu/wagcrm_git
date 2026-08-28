import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/repositories/orderFulfillmentRepository", () => ({
  orderFulfillmentRepository: { getPoRequestedSet: vi.fn().mockResolvedValue(new Set<string>()) },
}));

import { getPrisma } from "@/lib/prisma";
import { orderFulfillmentRepository } from "@/repositories/orderFulfillmentRepository";
import {
  computeCampaignSalesDetail,
  computeCampaignSalesDetailForTargets,
  getMobileCampaignGroupSales,
  getMobileCampaignSales,
  shouldReadLiveCampaignSales,
} from "../mobile-campaign-sales";
import {
  computeSnapshotDailyAggregate,
  SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE,
} from "@/lib/order-converter/daily-aggregate";
import type { PulseOrderLike, PulseSalesCampaignSource } from "../mobile-pulse-data";

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// 2026-07-08 진행중 캠페인 1개(1차) — 발주 캠페인 OC-1, 상품명 "콜라겐".
function makeCampaign(overrides: Partial<PulseSalesCampaignSource> = {}): PulseSalesCampaignSource {
  return {
    id: "camp-1",
    dealName: "콜라겐",
    sellerName: "하늘언니",
    startMs: ms("2026-07-01T00:00:00+09:00"),
    endMs: ms("2026-07-31T23:59:59+09:00"),
    campaignDealIds: ["cd-1"],
    orderCampaign: {
      id: "oc-1",
      name: "콜라겐",
      productId: "P1",
      mappings: [
        { productName: "콜라겐", optionName: null, price: 30000, campaignDealId: "cd-1" },
      ],
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
const NOW = new Date("2026-07-08T12:00:00+09:00");

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// live 읽기 경로 하네스 — dailyAggregate 컬럼만 읽고, 못 쓰는 행만 블롭 폴백한다.
// salesCampaign.findMany 는 두 용도로 불린다: 형제 회차 조회(where.orderCampaignId.in)
// 와 폴백 집계 우주(where.orderCampaign.isActive — 데스크톱과 동일한 진행중 게이트)
// — where 로 갈라 응답한다.
// ---------------------------------------------------------------------------

/** loadAggregationCampaignSources 가 기대하는 행 형태(발주 연동 판매캠페인 전수). */
function aggregationUniverseRow() {
  return {
    id: "camp-1",
    startDate: new Date("2026-07-01T00:00:00+09:00"),
    endDate: new Date("2026-07-31T00:00:00+09:00"),
    campaignDeals: [{ id: "cd-1" }],
    orderCampaign: {
      id: "oc-1",
      name: "콜라겐",
      productId: "P1",
      mappings: [{ productName: "콜라겐", optionName: null, price: 30000, campaignDealId: "cd-1" }],
    },
  };
}

function mockLivePrisma(snapshotRows: Array<{ snapshotDate: string; dailyAggregate: unknown }>, blobOrders: PulseOrderLike[]) {
  const aggregateFindMany = vi.fn();
  const salesCampaignFindMany = vi.fn().mockImplementation(
    (args: {
      where: { orderCampaignId?: { in?: string[] }; orderCampaign?: { isActive?: boolean } };
    }) => {
      // 집계 우주 질의 — 데스크톱(campaigns-handler 의 activeCampaigns)과 같은 isActive 게이트.
      if (args.where.orderCampaign?.isActive) {
        return Promise.resolve([aggregationUniverseRow()]);
      }
      return Promise.resolve([{ id: "camp-1", startDate: new Date("2026-07-01T00:00:00+09:00") }]);
    },
  );

  const snapshotFindMany = vi.fn().mockImplementation((args: { select: Record<string, boolean> }) => {
    aggregateFindMany(args);
    // 폴백 조회는 orders 만 select 한다 — 집계 조회와 구분되는 유일한 신호.
    if (args.select.orders) return Promise.resolve([{ orders: blobOrders }]);
    return Promise.resolve(snapshotRows);
  });

  vi.mocked(getPrisma).mockReturnValue({
    salesCampaign: {
      findUnique: vi.fn().mockResolvedValue({
        id: "camp-1",
        status: "ACTIVE",
        startDate: new Date("2026-07-01T00:00:00+09:00"),
        orderCampaignId: "oc-1",
        orderCampaign: { isActive: true },
      }),
      findMany: salesCampaignFindMany,
    },
    naverOrderSnapshot: {
      findMany: snapshotFindMany,
      findFirst: vi.fn().mockResolvedValue({ lastCallTime: new Date("2026-07-08T11:30:00+09:00") }),
    },
  } as never);

  return { snapshotFindMany, salesCampaignFindMany };
}

describe("getMobileCampaignSales(live) — dailyAggregate 읽기 경로와 블롭 폴백", () => {
  // 같은 주문번호 2행(=주문 1건·수량 2) — 집계/폴백 양쪽이 같은 수치를 내야 한다.
  const liveOrders = [
    order({ orderId: "A", productOrderId: "A-1", quantity: 1 }),
    order({ orderId: "A", productOrderId: "A-2", quantity: 1 }),
  ];
  const expectedCumulative = { orders: 1, quantity: 2, revenue: 60000 };

  it("집계가 가용하면 orders 블롭을 아예 select 하지 않는다(egress 절감의 본체)", async () => {
    const aggregate = computeSnapshotDailyAggregate([makeCampaign()], liveOrders);
    const { snapshotFindMany } = mockLivePrisma([{ snapshotDate: TODAY, dailyAggregate: aggregate }], liveOrders);

    const detail = await getMobileCampaignSales("camp-1", NOW);

    expect(detail?.source).toBe("live");
    expect(detail?.cumulative).toEqual(expectedCumulative);
    // 창 조회는 1회뿐이고, 그 select 에 orders 가 없다 = 블롭을 읽지 않았다.
    const windowCalls = snapshotFindMany.mock.calls.map(([args]) => args.select);
    expect(windowCalls).toEqual([{ snapshotDate: true, dailyAggregate: true }]);
  });

  it("레거시 행(dailyAggregate=null)은 그 행만 블롭 폴백해 동일 수치를 낸다", async () => {
    const { snapshotFindMany } = mockLivePrisma([{ snapshotDate: TODAY, dailyAggregate: null }], liveOrders);

    const detail = await getMobileCampaignSales("camp-1", NOW);

    expect(detail?.cumulative).toEqual(expectedCumulative);
    expect(snapshotFindMany.mock.calls.some(([args]) => args.select.orders)).toBe(true);
  });

  it("쓰기 실패 마커({v:0})·버전 불일치 행도 블롭 폴백으로 안전 강등된다", async () => {
    const { snapshotFindMany } = mockLivePrisma(
      [{ snapshotDate: TODAY, dailyAggregate: SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE }],
      liveOrders,
    );

    const detail = await getMobileCampaignSales("camp-1", NOW);

    expect(detail?.cumulative).toEqual(expectedCumulative);
    expect(snapshotFindMany.mock.calls.some(([args]) => args.select.orders)).toBe(true);
  });

  it("스냅샷 쓰기 이후 신설·연동된 캠페인(멤버십 미커버)도 블롭 폴백한다", async () => {
    // 다른 캠페인만 담고 쓰인 집계 — 대상 camp-1 이 campaignIds 에 없다.
    const stale = computeSnapshotDailyAggregate([makeCampaign({ id: "camp-old" })], liveOrders);
    const { snapshotFindMany } = mockLivePrisma([{ snapshotDate: TODAY, dailyAggregate: stale }], liveOrders);

    const detail = await getMobileCampaignSales("camp-1", NOW);

    expect(detail?.cumulative).toEqual(expectedCumulative);
    expect(snapshotFindMany.mock.calls.some(([args]) => args.select.orders)).toBe(true);
  });

  it("poRequested 조회는 전체 주문이 아니라 뒤집힐 수 있는 후보만 넘긴다", async () => {
    const aggregate = computeSnapshotDailyAggregate([makeCampaign()], [
      order({ orderId: "A", productOrderId: "A-1", productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" }),
      order({ orderId: "B", productOrderId: "B-1", productOrderStatus: "DELIVERED" }), // completed = 후보 아님
    ]);
    mockLivePrisma([{ snapshotDate: TODAY, dailyAggregate: aggregate }], liveOrders);

    await getMobileCampaignSales("camp-1", NOW);

    expect(orderFulfillmentRepository.getPoRequestedSet).toHaveBeenCalledWith(["A-1"]);
  });

  it("발주요청 발송분은 배송대기로 이동한다(집계는 플래그를 굽지 않는다)", async () => {
    vi.mocked(orderFulfillmentRepository.getPoRequestedSet).mockResolvedValueOnce(new Set(["A-1"]));
    const aggregate = computeSnapshotDailyAggregate([makeCampaign()], [
      order({ orderId: "A", productOrderId: "A-1", productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" }),
    ]);
    mockLivePrisma([{ snapshotDate: TODAY, dailyAggregate: aggregate }], liveOrders);

    const detail = await getMobileCampaignSales("camp-1", NOW);

    expect(detail?.statusBreakdown.newOrderBefore).toBe(0);
    expect(detail?.statusBreakdown.pending).toBe(1);
  });
});

describe("computeCampaignSalesDetail", () => {
  it("counts distinct orders (같은 주문번호 2행 = 주문 1건·수량 2)", () => {
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", quantity: 1 }),
      order({ orderId: "A", productOrderId: "A-2", quantity: 1 }),
    ];
    const detail = computeCampaignSalesDetail([makeCampaign()], orders, TODAY, "camp-1");
    expect(detail.cumulative.orders).toBe(1);
    expect(detail.cumulative.quantity).toBe(2);
    expect(detail.cumulative.revenue).toBe(60000);
  });

  it("splits status distribution and keeps claims separate from valid totals", () => {
    const orders = [
      order({ orderId: "A", productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" }),
      order({ orderId: "B", productOrderStatus: "PAYED", placeOrderStatus: "OK" }),
      order({ orderId: "C", productOrderStatus: "PRODUCT_ORDERED" }),
      order({ orderId: "D", productOrderStatus: "DISPATCH_WAIT" }),
      order({ orderId: "E", productOrderStatus: "DELIVERING" }),
      order({ orderId: "F", productOrderStatus: "DELIVERED" }),
      order({ orderId: "G", productOrderStatus: "CANCELED" }),
      order({ orderId: "H", productOrderStatus: "RETURNED" }),
      order({ orderId: "I", productOrderStatus: "PAYMENT_WAITING" }), // invalid(결제대기), not a claim
    ];
    // poRequestedSet 미주입 → 발주요청 발송된 주문이 없으므로 배송대기 0.
    // 배송대기 의미 재정의: DISPATCH_WAIT(D)은 발주요청 전이면 "주문확인 후"로 분류된다.
    const detail = computeCampaignSalesDetail([makeCampaign()], orders, TODAY, "camp-1");
    expect(detail.statusBreakdown).toEqual({
      newOrderBefore: 1,
      newOrderAfter: 3, // PAYED placed + PRODUCT_ORDERED + DISPATCH_WAIT(발주요청 전)
      pending: 0,
      shipping: 1,
      completed: 1,
    });
    expect(detail.claims).toEqual({ canceled: 1, returned: 1, exchanged: 0 });
    // 유효 6건(A~F), 클레임·결제대기 제외
    expect(detail.cumulative.orders).toBe(6);
  });

  it("발주요청 발송된 상품주문(poRequestedSet)은 배송대기로 분류된다", () => {
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", productOrderStatus: "PAYED", placeOrderStatus: "OK" }),
      order({ orderId: "B", productOrderId: "B-1", productOrderStatus: "DISPATCH_WAIT" }),
      order({ orderId: "C", productOrderId: "C-1", productOrderStatus: "DELIVERING" }),
    ];
    // A-1, B-1은 발주요청 발송됨 → 배송대기. C-1은 이미 배송중이라 배송대기보다 우선.
    const poRequestedSet = new Set(["A-1", "B-1", "C-1"]);
    const detail = computeCampaignSalesDetail([makeCampaign()], orders, TODAY, "camp-1", poRequestedSet);
    expect(detail.statusBreakdown).toEqual({
      newOrderBefore: 0,
      newOrderAfter: 0,
      pending: 2, // A-1, B-1
      shipping: 1, // C-1 (배송중이 배송대기보다 우선)
      completed: 0,
    });
  });

  it("separates today from cumulative by KST payment date", () => {
    const orders = [
      order({ orderId: "A", paymentDate: "2026-07-08T09:00:00+09:00" }),
      order({ orderId: "B", paymentDate: "2026-07-07T09:00:00+09:00" }),
    ];
    const detail = computeCampaignSalesDetail([makeCampaign()], orders, TODAY, "camp-1");
    expect(detail.cumulative.orders).toBe(2);
    expect(detail.today.orders).toBe(1);
    expect(detail.daily.map((d) => d.date)).toEqual(["2026-07-07", "2026-07-08"]);
    expect(detail.daily[1]).toEqual({ date: "2026-07-08", orders: 1, revenue: 30000 });
  });

  it("attributes orders to the correct round when siblings share an OrderCampaign", () => {
    const round1 = makeCampaign({
      id: "camp-1",
      startMs: ms("2026-07-01T00:00:00+09:00"),
      endMs: ms("2026-07-10T23:59:59+09:00"),
    });
    const round2 = makeCampaign({
      id: "camp-2",
      startMs: ms("2026-07-11T00:00:00+09:00"),
      endMs: ms("2026-07-31T23:59:59+09:00"),
    });
    const orders = [
      order({ orderId: "A", paymentDate: "2026-07-05T10:00:00+09:00" }), // round1
      order({ orderId: "B", paymentDate: "2026-07-15T10:00:00+09:00" }), // round2
    ];
    const round2Detail = computeCampaignSalesDetail(
      [round1, round2],
      orders,
      TODAY,
      "camp-2",
    );
    expect(round2Detail.cumulative.orders).toBe(1); // only B, not A
    expect(round2Detail.daily.map((d) => d.date)).toEqual(["2026-07-15"]);
  });

  it("aggregates grouped target campaigns without double-counting the same order number", () => {
    const groupA = makeCampaign({
      id: "camp-1",
      campaignDealIds: ["cd-1"],
      orderCampaign: {
        id: "oc-1",
        name: "콜라겐",
        productId: "P1",
        mappings: [
          { productName: "콜라겐", optionName: "A", price: 30000, campaignDealId: "cd-1" },
          { productName: "콜라겐", optionName: "B", price: 40000, campaignDealId: "cd-2" },
        ],
      },
    });
    const groupB = makeCampaign({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      orderCampaign: groupA.orderCampaign,
    });
    const orders = [
      order({ orderId: "A", productOrderId: "A-1", productOption: "A", totalPaymentAmount: 30000 }),
      order({ orderId: "A", productOrderId: "A-2", productOption: "B", totalPaymentAmount: 40000 }),
    ];

    const detail = computeCampaignSalesDetailForTargets(
      [groupA, groupB],
      orders,
      TODAY,
      new Set(["camp-1", "camp-2"]),
    );

    expect(detail.cumulative.orders).toBe(1);
    expect(detail.cumulative.quantity).toBe(2);
    expect(detail.cumulative.revenue).toBe(70000);
    expect(detail.items.map((item) => item.name)).toEqual(["콜라겐 · B", "콜라겐 · A"]);
  });

  it("returns all-zero detail when the campaign has no matching orders", () => {
    const orders = [order({ orderId: "A", productName: "전혀다른상품", productId: "ZZ" })];
    const detail = computeCampaignSalesDetail([makeCampaign()], orders, TODAY, "camp-1");
    expect(detail.cumulative.orders).toBe(0);
    expect(detail.claims).toEqual({ canceled: 0, returned: 0, exchanged: 0 });
    expect(detail.daily).toEqual([]);
  });
});

describe("shouldReadLiveCampaignSales", () => {
  it("SalesCampaign이 CLOSED여도 연결된 OrderCampaign이 활성이라면 live 스냅샷을 읽는다", () => {
    expect(
      shouldReadLiveCampaignSales({
        status: "CLOSED",
        orderCampaign: { isActive: true },
      }),
    ).toBe(true);
  });

  it("OrderCampaign이 마감된 캠페인은 cached 통계를 읽는다", () => {
    expect(
      shouldReadLiveCampaignSales({
        status: "CLOSED",
        orderCampaign: { isActive: false },
      }),
    ).toBe(false);
  });
});

describe("getMobileCampaignGroupSales", () => {
  it("dedupes a shared OrderCampaign before reading cached group sales", async () => {
    const salesCampaignFindMany = vi.fn().mockResolvedValue([
      { id: "camp-1", status: "CLOSED", orderCampaignId: "oc-1", orderCampaign: { isActive: false } },
      { id: "camp-2", status: "CLOSED", orderCampaignId: "oc-1", orderCampaign: { isActive: false } },
    ]);
    const orderCampaignFindMany = vi.fn().mockResolvedValue([
      {
        cachedNewOrderBeforeCount: 1,
        cachedNewOrderAfterCount: 2,
        cachedPendingCount: 3,
        cachedShippingCount: 4,
        cachedCompletedCount: 5,
        cachedTotalOrders: 6,
        cachedDistinctOrderCount: 4,
        cachedTotalQuantity: 7,
        cachedTotalRevenue: 80000,
        cachedDailyStats: [{ date: "2026-07-07", orders: 4, revenue: 80000 }],
      },
    ]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: { findMany: salesCampaignFindMany },
      orderCampaign: { findMany: orderCampaignFindMany },
    } as never);

    const detail = await getMobileCampaignGroupSales("group-1", new Date("2026-07-08T12:00:00+09:00"));

    expect(orderCampaignFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["oc-1"] } },
      select: expect.any(Object),
    });
    expect(detail?.source).toBe("cached");
    expect(detail?.cumulative).toEqual({ orders: 4, quantity: 7, revenue: 80000 });
    expect(detail?.statusBreakdown).toEqual({
      newOrderBefore: 1,
      newOrderAfter: 2,
      pending: 3,
      shipping: 4,
      completed: 5,
    });
    expect(detail?.daily).toEqual([{ date: "2026-07-07", orders: 4, revenue: 80000 }]);
  });

  it("dedupes cached group order numbers across different OrderCampaigns when snapshots exist", async () => {
    const orderCampaignFindMany = vi.fn().mockResolvedValue([
      {
        cachedNewOrderBeforeCount: 1,
        cachedNewOrderAfterCount: 0,
        cachedPendingCount: 0,
        cachedShippingCount: 0,
        cachedCompletedCount: 0,
        cachedTotalOrders: 1,
        cachedDistinctOrderCount: 1,
        cachedTotalQuantity: 1,
        cachedTotalRevenue: 30000,
        cachedDailyStats: [{ date: "2026-07-07", orders: 1, revenue: 30000 }],
        cachedProductOrderIds: ["PO-1"],
      },
      {
        cachedNewOrderBeforeCount: 0,
        cachedNewOrderAfterCount: 1,
        cachedPendingCount: 0,
        cachedShippingCount: 0,
        cachedCompletedCount: 0,
        cachedTotalOrders: 1,
        cachedDistinctOrderCount: 1,
        cachedTotalQuantity: 1,
        cachedTotalRevenue: 40000,
        cachedDailyStats: [{ date: "2026-07-07", orders: 1, revenue: 40000 }],
        cachedProductOrderIds: ["PO-2"],
      },
    ]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          { id: "camp-1", status: "CLOSED", orderCampaignId: "oc-1", orderCampaign: { isActive: false } },
          { id: "camp-2", status: "CLOSED", orderCampaignId: "oc-2", orderCampaign: { isActive: false } },
        ]),
      },
      orderCampaign: { findMany: orderCampaignFindMany },
      naverOrderSnapshot: {
        findMany: vi.fn().mockResolvedValue([
          {
            orders: [
              order({
                orderId: "ORDER-1",
                productOrderId: "PO-1",
                paymentDate: "2026-07-07T10:00:00+09:00",
                totalPaymentAmount: 30000,
              }),
              order({
                orderId: "ORDER-1",
                productOrderId: "PO-2",
                paymentDate: "2026-07-07T10:00:00+09:00",
                totalPaymentAmount: 40000,
              }),
            ],
          },
        ]),
      },
    } as never);

    const detail = await getMobileCampaignGroupSales("group-1", new Date("2026-07-08T12:00:00+09:00"));

    expect(detail?.source).toBe("cached");
    expect(detail?.cumulative).toEqual({ orders: 1, quantity: 2, revenue: 70000 });
    expect(detail?.daily).toEqual([{ date: "2026-07-07", orders: 1, revenue: 70000 }]);
  });

  it("그룹 distinct 재산출이 집계 가용 행에서는 orders 블롭을 select하지 않는다(egress 절감)", async () => {
    const camp1 = makeCampaign();
    const camp2 = makeCampaign({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      orderCampaign: {
        id: "oc-2",
        name: "비타민",
        productId: "P2",
        mappings: [{ productName: "비타민", optionName: null, price: 40000, campaignDealId: "cd-2" }],
      },
    });
    // 한 결제(ORDER-1)가 두 멤버 캠페인에 한 라인씩 걸친 조합 캠페인 — union이면 1건이다.
    const aggregate = computeSnapshotDailyAggregate([camp1, camp2], [
      order({
        orderId: "ORDER-1",
        productOrderId: "PO-1",
        paymentDate: "2026-07-07T10:00:00+09:00",
        totalPaymentAmount: 30000,
      }),
      order({
        orderId: "ORDER-1",
        productOrderId: "PO-2",
        productName: "비타민",
        productId: "P2",
        paymentDate: "2026-07-07T10:00:00+09:00",
        totalPaymentAmount: 40000,
      }),
    ]);

    const snapshotFindMany = vi.fn().mockResolvedValue([
      { snapshotDate: "2026-07-07", dailyAggregate: aggregate },
    ]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          { id: "camp-1", status: "CLOSED", orderCampaignId: "oc-1", orderCampaign: { isActive: false } },
          { id: "camp-2", status: "CLOSED", orderCampaignId: "oc-2", orderCampaign: { isActive: false } },
        ]),
      },
      orderCampaign: {
        findMany: vi.fn().mockResolvedValue([
          {
            cachedNewOrderBeforeCount: 1,
            cachedNewOrderAfterCount: 0,
            cachedPendingCount: 0,
            cachedShippingCount: 0,
            cachedCompletedCount: 0,
            cachedTotalOrders: 1,
            cachedDistinctOrderCount: 1,
            cachedTotalQuantity: 1,
            cachedTotalRevenue: 30000,
            cachedDailyStats: [{ date: "2026-07-07", orders: 1, revenue: 30000 }],
            // cachedProductOrderIds 부재 — 집계 경로는 이 컬럼 없이도 재산출한다(레거시 전용 폴백 입력).
          },
          {
            cachedNewOrderBeforeCount: 0,
            cachedNewOrderAfterCount: 1,
            cachedPendingCount: 0,
            cachedShippingCount: 0,
            cachedCompletedCount: 0,
            cachedTotalOrders: 1,
            cachedDistinctOrderCount: 1,
            cachedTotalQuantity: 1,
            cachedTotalRevenue: 40000,
            cachedDailyStats: [{ date: "2026-07-07", orders: 1, revenue: 40000 }],
          },
        ]),
      },
      naverOrderSnapshot: { findMany: snapshotFindMany },
    } as never);

    const detail = await getMobileCampaignGroupSales("group-1", new Date("2026-07-08T12:00:00+09:00"));

    // 블롭 폴백 없이 집계 select 1회로 끝나야 한다.
    expect(snapshotFindMany).toHaveBeenCalledTimes(1);
    expect(snapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { snapshotDate: true, dailyAggregate: true } }),
    );
    expect(detail?.source).toBe("cached");
    expect(detail?.cumulative).toEqual({ orders: 1, quantity: 2, revenue: 70000 });
    expect(detail?.daily).toEqual([{ date: "2026-07-07", orders: 1, revenue: 70000 }]);
  });

  it("집계 미가용(레거시) 행만 블롭 폴백하고 집계 행과 합성한다", async () => {
    const camp1 = makeCampaign();
    const camp2 = makeCampaign({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      orderCampaign: {
        id: "oc-2",
        name: "비타민",
        productId: "P2",
        mappings: [{ productName: "비타민", optionName: null, price: 40000, campaignDealId: "cd-2" }],
      },
    });
    const aggregate = computeSnapshotDailyAggregate([camp1, camp2], [
      order({
        orderId: "ORDER-1",
        productOrderId: "PO-1",
        paymentDate: "2026-07-07T10:00:00+09:00",
        totalPaymentAmount: 30000,
      }),
    ]);

    const snapshotFindMany = vi.fn().mockImplementation((args: { where: { snapshotDate: { in?: string[] } } }) => {
      if (args.where.snapshotDate.in) {
        // 2단계(레거시 행만): 07-06 블롭
        expect(args.where.snapshotDate.in).toEqual(["2026-07-06"]);
        return Promise.resolve([
          {
            orders: [
              order({
                orderId: "ORDER-0",
                productOrderId: "PO-0",
                paymentDate: "2026-07-06T10:00:00+09:00",
                totalPaymentAmount: 30000,
              }),
            ],
          },
        ]);
      }
      return Promise.resolve([
        { snapshotDate: "2026-07-06", dailyAggregate: null },
        { snapshotDate: "2026-07-07", dailyAggregate: aggregate },
      ]);
    });

    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          { id: "camp-1", status: "CLOSED", orderCampaignId: "oc-1", orderCampaign: { isActive: false } },
          { id: "camp-2", status: "CLOSED", orderCampaignId: "oc-2", orderCampaign: { isActive: false } },
        ]),
      },
      orderCampaign: {
        findMany: vi.fn().mockResolvedValue([
          {
            cachedTotalOrders: 2,
            cachedDistinctOrderCount: 2,
            cachedTotalQuantity: 2,
            cachedTotalRevenue: 60000,
            cachedDailyStats: [
              { date: "2026-07-06", orders: 1, revenue: 30000 },
              { date: "2026-07-07", orders: 1, revenue: 30000 },
            ],
            cachedProductOrderIds: ["PO-0", "PO-1"],
          },
          {
            cachedTotalOrders: 1,
            cachedDistinctOrderCount: 1,
            cachedTotalQuantity: 1,
            cachedTotalRevenue: 40000,
            cachedDailyStats: [{ date: "2026-07-07", orders: 1, revenue: 40000 }],
            cachedProductOrderIds: ["PO-2"],
          },
        ]),
      },
      naverOrderSnapshot: { findMany: snapshotFindMany },
    } as never);

    const detail = await getMobileCampaignGroupSales("group-1", new Date("2026-07-08T12:00:00+09:00"));

    expect(snapshotFindMany).toHaveBeenCalledTimes(2);
    expect(detail?.source).toBe("cached");
    // 07-06 블롭(ORDER-0) + 07-07 집계(ORDER-1) = distinct 2건
    expect(detail?.cumulative.orders).toBe(2);
    expect(detail?.daily).toEqual([
      { date: "2026-07-06", orders: 1, revenue: 30000 },
      { date: "2026-07-07", orders: 1, revenue: 70000 },
    ]);
  });
});

/**
 * 마감(cached) 경로의 인트라데이 — 마감 시 동결한 `cachedIntradayBuckets` 를 읽는다.
 * live 경로(스냅샷 집계)와 **형태가 동형**이어야 한다: 타임라인 라우트와 차트가 같은 형태를
 * 소비하므로, 갈라지면 같은 화면이 두 갈래로 나뉜다.
 */
describe("getMobileCampaignSales(cached) — 마감 캠페인 인트라데이 동결 읽기", () => {
  const FROZEN = {
    bv: 1,
    days: { "2026-07-07": { "54": [2, 30000], "60": [1, 50000] } },
  };

  function mockClosedCampaign(orderCampaignRow: Record<string, unknown>) {
    const findUnique = vi.fn().mockResolvedValue(orderCampaignRow);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue({
          id: "camp-1",
          status: "CLOSED",
          startDate: new Date("2026-07-01T00:00:00+09:00"),
          orderCampaignId: "oc-1",
          orderCampaign: { isActive: false },
        }),
      },
      orderCampaign: { findUnique },
    } as never);
    return findUnique;
  }

  const CACHED_ROW = {
    cachedNewOrderBeforeCount: 0,
    cachedNewOrderAfterCount: 0,
    cachedPendingCount: 0,
    cachedShippingCount: 0,
    cachedCompletedCount: 3,
    cachedTotalOrders: 3,
    cachedDistinctOrderCount: 3,
    cachedTotalQuantity: 3,
    cachedTotalRevenue: 80000,
    cachedDailyStats: [{ date: "2026-07-07", orders: 3, revenue: 80000 }],
  };

  it("동결 버킷이 있으면 10분 점 열을 만든다 (KST 기준 시각)", async () => {
    mockClosedCampaign({ ...CACHED_ROW, cachedIntradayBuckets: FROZEN });

    const detail = await getMobileCampaignSales("camp-1", new Date("2026-07-08T12:00:00+09:00"), {
      includeIntraday: true,
    });

    expect(detail?.source).toBe("cached");
    expect(detail?.intraday?.points).toEqual([
      { startMs: ms("2026-07-07T09:00:00+09:00"), orders: 2, revenue: 30000 },
      { startMs: ms("2026-07-07T10:00:00+09:00"), orders: 1, revenue: 50000 },
    ]);
    expect(detail?.intraday?.daysWithoutBuckets).toEqual([]);
  });

  it("동결 이전에 마감된 캠페인(컬럼 null)은 intraday=null 로 degrade — 일별은 그대로다", async () => {
    mockClosedCampaign({ ...CACHED_ROW, cachedIntradayBuckets: null });

    const detail = await getMobileCampaignSales("camp-1", new Date("2026-07-08T12:00:00+09:00"), {
      includeIntraday: true,
    });

    expect(detail?.intraday).toBeNull();
    expect(detail?.daily).toEqual([{ date: "2026-07-07", orders: 3, revenue: 80000 }]);
    expect(detail?.cumulative).toEqual({ orders: 3, quantity: 3, revenue: 80000 });
  });

  it("일별에는 있는데 버킷이 없는 날짜는 daysWithoutBuckets 로 고지한다", async () => {
    mockClosedCampaign({
      ...CACHED_ROW,
      cachedDailyStats: [
        { date: "2026-07-06", orders: 1, revenue: 10000 },
        { date: "2026-07-07", orders: 3, revenue: 80000 },
      ],
      cachedIntradayBuckets: FROZEN,
    });

    const detail = await getMobileCampaignSales("camp-1", new Date("2026-07-08T12:00:00+09:00"), {
      includeIntraday: true,
    });

    expect(detail?.intraday?.daysWithoutBuckets).toEqual(["2026-07-06"]);
  });

  it("요청하지 않으면 컬럼을 select 하지도, 필드를 싣지도 않는다(페이로드 규약)", async () => {
    const findUnique = mockClosedCampaign({ ...CACHED_ROW, cachedIntradayBuckets: FROZEN });

    const detail = await getMobileCampaignSales("camp-1", new Date("2026-07-08T12:00:00+09:00"));

    expect(detail).not.toHaveProperty("intraday");
    const select = findUnique.mock.calls[0][0].select as Record<string, unknown>;
    expect(select).not.toHaveProperty("cachedIntradayBuckets");
  });
});

/**
 * 조회 창 회귀 — **"now 를 미래로 옮겨도 집계가 줄지 않는다"**.
 *
 * 종전 구현은 조회 시작을 `now − 30일`로 하한해, 캠페인 시작 후 30일이 지나면 초반 날짜가
 * 하루에 하나씩 조회 밖으로 밀려나 **주문 건수·매출 숫자 자체가 조용히 줄었다**. 노출 구간은
 * 캠페인 종료 ~ 발주 마감 사이라(마감하면 cached 경로가 전 기간 동결본을 읽어 자연 치유)
 * "마감을 늦게 누를수록 수치가 줄어드는" 형태였다.
 *
 * 이 테스트의 mock 은 **`where.snapshotDate` 범위를 실제로 존중한다** — 위 live 하네스처럼
 * 범위를 무시하면 결함이 재현되지 않아 테스트가 통과해도 아무것도 증명하지 못한다.
 */
describe("getMobileCampaignSales(live) — 조회 창이 시간에 따라 갉히지 않는다", () => {
  const CAMPAIGN_START = new Date("2026-07-13T00:00:00+09:00");
  const DATES = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"];

  /** 하루 1건·10,000원짜리 리프. */
  function dayAggregate(dateKey: string, orderKey: string) {
    return {
      v: 1,
      bv: 1,
      campaignIds: ["camp-1"],
      days: {
        [dateKey]: {
          "camp-1": {
            orderKeys: [orderKey],
            validLines: 1,
            quantity: 1,
            revenue: 10000,
            statusBreakdown: { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 1 },
            poCandidates: { newBefore: [], newAfter: [], other: [] },
            claims: { canceled: 0, returned: 0, exchanged: 0 },
            items: [],
            buckets: {},
          },
        },
      },
    };
  }

  const ROWS = DATES.map((date, i) => ({ snapshotDate: date, dailyAggregate: dayAggregate(date, `O${i}`) }));

  function mockRangeRespectingPrisma() {
    const snapshotFindMany = vi.fn().mockImplementation(
      (args: { where?: { snapshotDate?: { gte?: string; lte?: string } }; select: Record<string, boolean> }) => {
        if (args.select.orders) return Promise.resolve([]); // 블롭 폴백 없음(전 행에 집계가 있다)
        const gte = args.where?.snapshotDate?.gte ?? "";
        const lte = args.where?.snapshotDate?.lte ?? "9999-99-99";
        return Promise.resolve(ROWS.filter((row) => row.snapshotDate >= gte && row.snapshotDate <= lte));
      },
    );
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue({
          id: "camp-1",
          status: "ACTIVE",
          startDate: CAMPAIGN_START,
          orderCampaignId: "oc-1",
          orderCampaign: { isActive: true },
        }),
        findMany: vi.fn().mockResolvedValue([{ id: "camp-1", startDate: CAMPAIGN_START }]),
      },
      naverOrderSnapshot: {
        findMany: snapshotFindMany,
        findFirst: vi.fn().mockResolvedValue({ lastCallTime: new Date("2026-07-16T11:30:00+09:00") }),
      },
    } as never);
    return snapshotFindMany;
  }

  it.each([
    ["시작 +4일", "2026-07-17T12:00:00+09:00"],
    ["시작 +31일 (종전 구현이 갉기 시작하던 지점)", "2026-08-13T12:00:00+09:00"],
    ["시작 +38일", "2026-08-20T12:00:00+09:00"],
    ["시작 +80일", "2026-10-01T12:00:00+09:00"],
  ])("now=%s 여도 누적·일별이 그대로다", async (_label, nowIso) => {
    mockRangeRespectingPrisma();

    const detail = await getMobileCampaignSales("camp-1", new Date(nowIso));

    expect(detail?.source).toBe("live");
    expect(detail?.cumulative).toEqual({ orders: 4, quantity: 4, revenue: 40000 });
    expect(detail?.daily.map((point) => point.date)).toEqual(DATES);
    expect(detail?.coverage).toEqual({ startDate: "2026-07-13", truncated: false });
  });

  it("조회 범위의 시작은 now 가 아니라 캠페인 시작일이다", async () => {
    const snapshotFindMany = mockRangeRespectingPrisma();

    await getMobileCampaignSales("camp-1", new Date("2026-08-20T12:00:00+09:00"));

    expect(snapshotFindMany.mock.calls[0][0].where.snapshotDate).toEqual({
      gte: "2026-07-13",
      lte: "2026-08-20",
    });
  });
});
