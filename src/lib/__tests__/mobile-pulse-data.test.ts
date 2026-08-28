import { describe, expect, it } from "vitest";
import {
  computePulse,
  endOfDayKstMs,
  toDateKeyKst,
  type PulseOrderLike,
  type PulseSalesCampaignSource,
} from "@/lib/mobile-pulse-data";

/**
 * 모바일 판매 펄스 순수 집계(computePulse) 검증.
 * 관문(MOBILE_UX_PLAN §9 Phase 2): 주문건수 = distinct 주문번호(resolveOrderCountKey 상당),
 * quantity 필드(수량, 구 orderCount 컬럼)와 절대 혼동하지 않는다.
 */

const TODAY_KEY = "2026-07-08";

function kst(iso: string): string {
  return `${iso}+09:00`;
}

function makeCampaign(
  overrides: Partial<PulseSalesCampaignSource> = {},
): PulseSalesCampaignSource {
  return {
    id: "sc-1",
    dealName: "프리미엄 마린콜라겐",
    sellerName: "하늘언니",
    startMs: new Date(kst("2026-07-01T00:00:00")).getTime(),
    endMs: endOfDayKstMs(new Date(kst("2026-07-31T00:00:00"))),
    campaignDealIds: ["cd-1"],
    orderCampaign: {
      id: "oc-1",
      name: "프리미엄 마린콜라겐",
      productId: "1001",
      mappings: [
        {
          productName: "프리미엄 마린콜라겐",
          optionName: "3박스",
          price: 30000,
          campaignDealId: "cd-1",
        },
      ],
    },
    ...overrides,
  };
}

function makeOrder(overrides: Partial<PulseOrderLike> = {}): PulseOrderLike {
  return {
    orderId: "O-1",
    productOrderId: "PO-1",
    productOrderStatus: "PAYED",
    productId: "1001",
    productName: "프리미엄 마린콜라겐 3박스",
    productOption: "3박스",
    quantity: 1,
    totalPaymentAmount: 30000,
    paymentDate: kst("2026-07-08T10:00:00"),
    ...overrides,
  };
}

describe("toDateKeyKst / endOfDayKstMs", () => {
  it("converts a UTC instant to the KST date key", () => {
    // 2026-07-07 16:30 UTC = 2026-07-08 01:30 KST
    expect(toDateKeyKst(new Date("2026-07-07T16:30:00Z"))).toBe("2026-07-08");
  });

  it("extends an end date to KST end-of-day so last-day orders stay in window", () => {
    const midnight = new Date(kst("2026-07-31T00:00:00"));
    const lastDayOrder = new Date(kst("2026-07-31T21:00:00")).getTime();
    expect(endOfDayKstMs(midnight)).toBeGreaterThanOrEqual(lastDayOrder);
  });
});

describe("computePulse — 주문 건수 vs 수량", () => {
  it("counts the same orderId across two lines as 1 order with quantity 2", () => {
    const orders = [
      makeOrder({ productOrderId: "PO-1", quantity: 1 }),
      makeOrder({ productOrderId: "PO-2", quantity: 1 }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today.orders).toBe(1); // distinct orderId = 1건
    expect(result.today.quantity).toBe(2); // 라인 수량 합 = 2
    expect(result.today.revenue).toBe(60000);
    expect(result.byCampaign[0]?.todayOrders).toBe(1);
  });

  it("falls back to productOrderId as the distinct key when orderId is missing", () => {
    const orders = [
      makeOrder({ orderId: null, productOrderId: "PO-1" }),
      makeOrder({ orderId: null, productOrderId: "PO-2" }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today.orders).toBe(2);
    expect(result.today.quantity).toBe(2);
  });
});

describe("computePulse — 유효 주문 필터", () => {
  it("excludes canceled/returned/exchanged/payment-waiting/nopayment-canceled orders entirely", () => {
    // 상태 문자열은 네이버 커머스 productOrderStatus 실제 enum과 정확히 일치해야 한다.
    // (과거 'PAY_WAITING' 오타로 결제대기 주문이 매출에 새어들던 실사고 회귀 가드 — 2026-07-10)
    const orders = [
      makeOrder({ orderId: "O-1", productOrderStatus: "CANCELED" }),
      makeOrder({ orderId: "O-2", productOrderStatus: "RETURNED" }),
      makeOrder({ orderId: "O-3", productOrderStatus: "EXCHANGED" }),
      makeOrder({ orderId: "O-4", productOrderStatus: "PAYMENT_WAITING" }),
      makeOrder({ orderId: "O-5", productOrderStatus: "CANCELED_BY_NOPAYMENT" }),
      makeOrder({ orderId: "O-6", productOrderStatus: "DELIVERED" }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today.orders).toBe(1);
    expect(result.today.quantity).toBe(1);
    expect(result.today.revenue).toBe(30000);
  });
});

describe("computePulse — 오늘 vs 누적", () => {
  it("splits today and cumulative by KST payment date", () => {
    const orders = [
      makeOrder({ orderId: "O-1", paymentDate: kst("2026-07-08T09:00:00") }),
      makeOrder({ orderId: "O-2", paymentDate: kst("2026-07-05T09:00:00") }),
      makeOrder({ orderId: "O-3", paymentDate: kst("2026-07-02T09:00:00") }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today).toEqual({ orders: 1, quantity: 1, revenue: 30000 });
    expect(result.cumulative).toEqual({ orders: 3, quantity: 3, revenue: 90000 });
  });

  it("counts an order paid late on the 7th UTC as the 8th in KST (KST 귀속)", () => {
    // 2026-07-07T16:00Z = 2026-07-08 01:00 KST → 오늘
    const orders = [makeOrder({ paymentDate: "2026-07-07T16:00:00Z" })];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today.orders).toBe(1);
  });

  it("excludes orders outside the campaign window", () => {
    const orders = [makeOrder({ paymentDate: kst("2026-06-15T09:00:00") })];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.cumulative.orders).toBe(0);
  });
});

describe("computePulse — 매출 규칙", () => {
  it("adds naver-funded discount back into seller revenue", () => {
    const orders = [
      makeOrder({
        totalPaymentAmount: 27000,
        productDiscountAmount: 5000,
        sellerBurdenDiscountAmount: 2000,
      }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    // 27,000 + max(0, 5,000 - 2,000) = 30,000
    expect(result.today.revenue).toBe(30000);
  });

  it("falls back to mapping price × quantity when payment amount is missing", () => {
    const orders = [makeOrder({ totalPaymentAmount: undefined, quantity: 2 })];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.today.revenue).toBe(60000); // 30,000 × 2
  });
});

describe("computePulse — 추가구성상품 2차 귀속", () => {
  it("attributes an addon line to the campaign that owns the matched main productId", () => {
    const orders = [
      makeOrder({ orderId: "O-1", productOrderId: "PO-1" }),
      makeOrder({
        orderId: "O-1",
        productOrderId: "PO-2",
        productClass: "추가구성상품",
        productName: "아이보리",
        productOption: "파우치: 아이보리",
        totalPaymentAmount: 5000,
      }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    // 같은 orderId → 여전히 주문 1건, 수량 2, 매출 합산
    expect(result.today.orders).toBe(1);
    expect(result.today.quantity).toBe(2);
    expect(result.today.revenue).toBe(35000);
  });

  it("ignores addon lines whose productId never matched a main line", () => {
    const orders = [
      makeOrder({
        productClass: "추가구성상품",
        productId: "9999",
        productName: "아이보리",
      }),
    ];

    const result = computePulse([makeCampaign()], orders, TODAY_KEY);

    expect(result.cumulative.orders).toBe(0);
  });
});

describe("computePulse — 회차(같은 발주 캠페인 공유) 귀속", () => {
  it("routes an order to the round whose window contains the payment time", () => {
    const sharedOc = {
      id: "oc-1",
      name: "프리미엄 마린콜라겐",
      productId: "1001",
      mappings: [],
    };
    const round1 = makeCampaign({
      id: "sc-r1",
      dealName: "프리미엄 마린콜라겐",
      startMs: new Date(kst("2026-06-01T00:00:00")).getTime(),
      endMs: endOfDayKstMs(new Date(kst("2026-06-10T00:00:00"))),
      campaignDealIds: ["cd-r1"],
      orderCampaign: sharedOc,
    });
    const round2 = makeCampaign({
      id: "sc-r2",
      startMs: new Date(kst("2026-07-01T00:00:00")).getTime(),
      endMs: endOfDayKstMs(new Date(kst("2026-07-31T00:00:00"))),
      campaignDealIds: ["cd-r2"],
      orderCampaign: sharedOc,
    });

    const result = computePulse(
      [round1, round2],
      [makeOrder({ paymentDate: kst("2026-07-08T10:00:00") })],
      TODAY_KEY,
    );

    const r1 = result.byCampaign.find((c) => c.campaignId === "sc-r1");
    const r2 = result.byCampaign.find((c) => c.campaignId === "sc-r2");
    expect(r2?.todayOrders).toBe(1);
    expect(r1?.todayOrders).toBe(0);
  });
});

describe("computePulse — 매핑 기반 매칭", () => {
  it("matches via product/option mapping when the product name differs from the OC name", () => {
    const campaign = makeCampaign({
      orderCampaign: {
        id: "oc-1",
        name: "와이그라운드 공구 특가전",
        productId: null,
        mappings: [
          {
            productName: "프리미엄 마린콜라겐",
            optionName: "3박스",
            price: 30000,
            campaignDealId: "cd-1",
          },
        ],
      },
    });

    const result = computePulse([campaign], [makeOrder({ productId: null })], TODAY_KEY);

    expect(result.today.orders).toBe(1);
    expect(result.byCampaign[0]?.todayRevenue).toBe(30000);
  });
});

describe("computePulse — byCampaign 정렬·상한", () => {
  it("sorts by today's orders desc and caps the list at 8 entries", () => {
    const campaigns = Array.from({ length: 10 }, (_, i) =>
      makeCampaign({
        id: `sc-${i}`,
        dealName: `딜-${i}`,
        campaignDealIds: [`cd-${i}`],
        orderCampaign: {
          id: `oc-${i}`,
          name: `딜-${i}`,
          productId: `${2000 + i}`,
          mappings: [],
        },
      }),
    );
    // 딜-3 에 오늘 주문 2건, 딜-7 에 1건
    const orders = [
      makeOrder({ orderId: "O-1", productId: "2003", productName: "딜-3" }),
      makeOrder({ orderId: "O-2", productId: "2003", productName: "딜-3" }),
      makeOrder({ orderId: "O-3", productId: "2007", productName: "딜-7" }),
    ];

    const result = computePulse(campaigns, orders, TODAY_KEY);

    expect(result.byCampaign).toHaveLength(8);
    expect(result.byCampaign[0]?.campaignId).toBe("sc-3");
    expect(result.byCampaign[0]?.todayOrders).toBe(2);
    expect(result.byCampaign[1]?.campaignId).toBe("sc-7");
  });
});

describe("computePulse — 빈 데이터", () => {
  it("returns zeros when there are no orders", () => {
    const result = computePulse([makeCampaign()], [], TODAY_KEY);

    expect(result.today).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(result.cumulative).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(result.byCampaign[0]).toEqual({
      campaignId: "sc-1",
      dealName: "프리미엄 마린콜라겐",
      sellerName: "하늘언니",
      todayOrders: 0,
      todayRevenue: 0,
    });
  });
});
