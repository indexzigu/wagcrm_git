import { describe, expect, it } from "vitest";
import {
  clusterCampaignEvents,
  computeCrossCampaignRepurchase,
  computeEventReturningBuyers,
} from "../cross-campaign-repurchase";
import type { PulseOrderLike, PulseSalesCampaignSource } from "../mobile-pulse-data";

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// 딜(상품)별 SalesCampaign 행. 날짜창(start~end)으로 회차 클러스터링을 검증한다.
function campaign(
  id: string,
  dealName: string,
  ocId: string,
  product: string,
  productId: string,
  startIso = "2026-07-01T00:00:00+09:00",
  endIso = "2026-07-10T23:59:59+09:00",
): PulseSalesCampaignSource {
  return {
    id,
    dealName,
    sellerName: "하늘언니",
    startMs: ms(startIso),
    endMs: ms(endIso),
    campaignDealIds: [`cd-${id}`],
    orderCampaign: {
      id: ocId,
      name: product,
      productId,
      mappings: [{ productName: product, optionName: null, price: 30000, campaignDealId: `cd-${id}` }],
    },
  };
}

function order(overrides: Partial<PulseOrderLike>): PulseOrderLike {
  return {
    orderId: "O",
    productOrderId: "PO",
    productOrderStatus: "PAYED",
    productName: "콜라겐",
    productId: "P1",
    quantity: 1,
    totalPaymentAmount: 30000,
    paymentDate: "2026-07-05T10:00:00+09:00",
    ...overrides,
  };
}

describe("clusterCampaignEvents", () => {
  it("collapses overlapping/identical windows into one event (한 공구의 여러 상품행)", () => {
    // 할인광녀 케이스: 같은 마켓의 3상품, 같은/겹치는 날짜창
    const a = campaign("a", "콜라겐", "oc-a", "콜라겐", "P1", "2026-06-15T00:00:00+09:00", "2026-06-23T23:59:59+09:00");
    const b = campaign("b", "비타민", "oc-b", "비타민", "P2", "2026-06-15T00:00:00+09:00", "2026-06-23T23:59:59+09:00");
    const c = campaign("c", "유산균", "oc-c", "유산균", "P3", "2026-06-18T00:00:00+09:00", "2026-06-25T23:59:59+09:00");
    expect(new Set(clusterCampaignEvents([a, b, c]).values()).size).toBe(1);
  });

  it("separates non-overlapping windows into distinct events (1차/2차)", () => {
    const r1 = campaign("r1", "콜라겐", "oc1", "콜라겐", "P1", "2026-06-01T00:00:00+09:00", "2026-06-10T23:59:59+09:00");
    const r2 = campaign("r2", "콜라겐", "oc2", "콜라겐", "P1", "2026-07-01T00:00:00+09:00", "2026-07-10T23:59:59+09:00");
    const m = clusterCampaignEvents([r1, r2]);
    expect(new Set(m.values()).size).toBe(2);
    expect(m.get("r1")).not.toBe(m.get("r2"));
  });
});

// 서로 다른 시기의 두 마켓(회차) — 회차간 재구매 검증용
const EVENT0 = campaign("c1", "콜라겐", "oc1", "콜라겐", "P1", "2026-06-01T00:00:00+09:00", "2026-06-10T23:59:59+09:00");
const EVENT1 = campaign("c2", "비타민", "oc2", "비타민", "P2", "2026-07-01T00:00:00+09:00", "2026-07-10T23:59:59+09:00");
const inEvent0 = { paymentDate: "2026-06-05T10:00:00+09:00" };
const inEvent1 = { paymentDate: "2026-07-05T10:00:00+09:00" };

describe("computeCrossCampaignRepurchase", () => {
  it("does NOT count multi-product purchases within ONE event/market (할인광녀 케이스)", () => {
    const collagen = campaign("c1", "콜라겐", "oc1", "콜라겐", "P1"); // 07-01~07-10
    const vitamin = campaign("c2", "비타민", "oc2", "비타민", "P2"); // 같은 창 07-01~07-10
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", paymentDate: "2026-07-03T10:00:00+09:00" }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", paymentDate: "2026-07-05T10:00:00+09:00" }),
    ];
    const r = computeCrossCampaignRepurchase([collagen, vitamin], orders);
    expect(r.eventsWithOrders).toBe(1); // 한 회차
    expect(r.totalBuyers).toBe(1);
    expect(r.crossCampaignBuyers).toBe(0); // 같은 회차 다상품 = 바스켓, 회차간 아님
  });

  it("counts a buyer across TWO time-separated events (1차/2차 회차간 재구매)", () => {
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
      order({ ordererNo: "200", orderId: "C", productName: "콜라겐", productId: "P1", ...inEvent0 }), // event0만
    ];
    const r = computeCrossCampaignRepurchase([EVENT0, EVENT1], orders);
    expect(r.eventsWithOrders).toBe(2);
    expect(r.totalBuyers).toBe(2);
    expect(r.crossCampaignBuyers).toBe(1); // 100만 두 회차 걸침
    expect(r.crossCampaignRatio).toBe(50);
  });

  it("excludes invalid/claim orders (canceled) from event attribution", () => {
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1, productOrderStatus: "CANCELED" }),
    ];
    const r = computeCrossCampaignRepurchase([EVENT0, EVENT1], orders);
    expect(r.crossCampaignBuyers).toBe(0); // event1 주문 취소 → 구매자는 event0만
  });

  it("falls back to ordererId when ordererNo is absent", () => {
    const orders = [
      order({ ordererNo: undefined, ordererId: "masked1", orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: undefined, ordererId: "masked1", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
    ];
    expect(computeCrossCampaignRepurchase([EVENT0, EVENT1], orders).crossCampaignBuyers).toBe(1);
  });

  it("excludes orders with no identity key from buyer counts", () => {
    const orders = [
      order({ ordererNo: undefined, ordererId: undefined, orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: "200", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
    ];
    const r = computeCrossCampaignRepurchase([EVENT0, EVENT1], orders);
    expect(r.totalBuyers).toBe(1); // 식별불가 주문 제외
    expect(r.crossCampaignBuyers).toBe(0);
  });

  it("returns zero cross-campaign buyers when only one event exists", () => {
    const collagen = campaign("c1", "콜라겐", "oc1", "콜라겐", "P1");
    const orders = [order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", paymentDate: "2026-07-03T10:00:00+09:00" })];
    const r = computeCrossCampaignRepurchase([collagen], orders);
    expect(r.eventsWithOrders).toBe(1);
    expect(r.crossCampaignBuyers).toBe(0);
  });

  it("exposes only aggregate counts — never buyer identities (§0-1 / PII contract)", () => {
    const secret = "SECRET_BUYER_9";
    const orders = [
      order({ ordererNo: secret, orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: secret, orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
    ];
    const r = computeCrossCampaignRepurchase([EVENT0, EVENT1], orders);
    expect(Object.keys(r).sort()).toEqual(
      ["crossCampaignBuyers", "crossCampaignRatio", "eventsWithOrders", "totalBuyers"].sort(),
    );
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

// 회차별 "재구매 고객" — 이번 회차 구매자 중 앞선 회차 구매이력자 비율 (셀러 포털 스탯)
describe("computeEventReturningBuyers", () => {
  it("counts buyers with purchase history in an EARLIER event only (2차 캠페인의 재구매 고객)", () => {
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }), // 이력 보유
      order({ ordererNo: "200", orderId: "C", productName: "비타민", productId: "P2", ...inEvent1 }), // 신규
    ];
    const per = computeEventReturningBuyers([EVENT0, EVENT1], orders);
    // 1차(event 0): 구매자 1명, 앞선 회차 없음 → 재구매 0
    expect(per.get(0)).toEqual({ buyers: 1, returningBuyers: 0, returningRatio: 0 });
    // 2차(event 1): 구매자 2명 중 100만 1차 이력 보유 → 50%
    expect(per.get(1)).toEqual({ buyers: 2, returningBuyers: 1, returningRatio: 50 });
  });

  it("does NOT count within-event multi-product purchases as returning (같은 마켓 다상품 = 바스켓)", () => {
    const collagen = campaign("c1", "콜라겐", "oc1", "콜라겐", "P1"); // 07-01~07-10
    const vitamin = campaign("c2", "비타민", "oc2", "비타민", "P2"); // 같은 창
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", paymentDate: "2026-07-03T10:00:00+09:00" }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", paymentDate: "2026-07-05T10:00:00+09:00" }),
    ];
    const per = computeEventReturningBuyers([collagen, vitamin], orders);
    expect(per.get(0)).toEqual({ buyers: 1, returningBuyers: 0, returningRatio: 0 });
  });

  it("dedups multiple orders by the same buyer within one event (분모도 순 구매자 기준)", () => {
    const orders = [
      order({ ordererNo: "100", orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: "100", orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
      order({ ordererNo: "100", orderId: "B2", productName: "비타민", productId: "P2", ...inEvent1 }), // 같은 회차 2번째 주문
      order({ ordererNo: "200", orderId: "C", productName: "비타민", productId: "P2", ...inEvent1 }),
    ];
    const per = computeEventReturningBuyers([EVENT0, EVENT1], orders);
    expect(per.get(1)).toEqual({ buyers: 2, returningBuyers: 1, returningRatio: 50 });
  });

  it("exposes only counts and ratios — never buyer identities (§0-1 / PII contract)", () => {
    const secret = "SECRET_BUYER_9";
    const orders = [
      order({ ordererNo: secret, orderId: "A", productName: "콜라겐", productId: "P1", ...inEvent0 }),
      order({ ordererNo: secret, orderId: "B", productName: "비타민", productId: "P2", ...inEvent1 }),
    ];
    const per = computeEventReturningBuyers([EVENT0, EVENT1], orders);
    for (const stat of per.values()) {
      expect(Object.keys(stat).sort()).toEqual(["buyers", "returningBuyers", "returningRatio"].sort());
    }
    expect(JSON.stringify([...per.entries()])).not.toContain(secret);
  });
});
