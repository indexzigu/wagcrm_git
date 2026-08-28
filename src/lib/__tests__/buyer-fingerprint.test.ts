import { describe, expect, it } from "vitest";
import {
  buyerKeyOf,
  hashBuyerKey,
  hashedBuyerKeyOf,
  collectCampaignBuyerHashes,
} from "../buyer-fingerprint";
import {
  computeCrossCampaignRepurchase,
  computeEventReturningBuyers,
  type BuyerFingerprintRow,
} from "../cross-campaign-repurchase";
import type { PulseOrderLike, PulseSalesCampaignSource } from "../mobile-pulse-data";

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function campaign(
  id: string,
  startIso: string,
  endIso: string,
  ocId = `oc-${id}`,
  product = "보조배터리",
  productId = "P1",
): PulseSalesCampaignSource {
  return {
    id,
    dealName: "보조배터리",
    sellerName: "김본명",
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
    productName: "보조배터리",
    productId: "P1",
    quantity: 1,
    totalPaymentAmount: 30000,
    ...overrides,
  };
}

describe("hashBuyerKey / buyerKeyOf", () => {
  it("같은 입력은 항상 같은 해시(결정성) — 캠페인·시간 무관 대조의 전제", () => {
    expect(hashBuyerKey("101696893")).toBe(hashBuyerKey("101696893"));
  });

  it("64자 hex이고 원문(ordererNo)이 포함되지 않는다(PII 계약)", () => {
    const h = hashBuyerKey("101696893");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("101696893");
  });

  it("다른 구매자는 다른 해시", () => {
    expect(hashBuyerKey("101696893")).not.toBe(hashBuyerKey("101696894"));
  });

  it("buyerKeyOf: ordererNo 우선, 없으면 ordererId 폴백, 둘 다 없으면 null", () => {
    expect(buyerKeyOf(order({ ordererNo: 123456789, ordererId: "abc***" }))).toBe("123456789");
    expect(buyerKeyOf(order({ ordererNo: null, ordererId: "abc***" }))).toBe("abc***");
    expect(buyerKeyOf(order({ ordererNo: null, ordererId: "" }))).toBeNull();
    expect(hashedBuyerKeyOf(order({ ordererNo: null, ordererId: null }))).toBeNull();
  });
});

describe("collectCampaignBuyerHashes (스위프의 순수 코어)", () => {
  const camp = campaign("sc-r2", "2026-07-06T00:00:00+09:00", "2026-07-11T23:59:59+09:00");

  it("유효주문을 캠페인에 귀속시켜 구매자 해시 집합을 만든다", () => {
    const map = collectCampaignBuyerHashes(
      [camp],
      [
        order({ productOrderId: "A", ordererNo: "111", paymentDate: "2026-07-07T10:00:00+09:00" }),
        order({ productOrderId: "B", ordererNo: "222", paymentDate: "2026-07-08T10:00:00+09:00" }),
        // 같은 구매자 재주문 — Set이 dedup
        order({ productOrderId: "C", ordererNo: "111", paymentDate: "2026-07-09T10:00:00+09:00" }),
      ],
    );
    const hashes = map.get("sc-r2")!;
    expect(hashes.size).toBe(2);
    expect(hashes.has(hashBuyerKey("111"))).toBe(true);
    expect(hashes.has(hashBuyerKey("222"))).toBe(true);
  });

  it("취소/클레임 주문과 식별키 없는 주문(비회원)은 제외한다", () => {
    const map = collectCampaignBuyerHashes(
      [camp],
      [
        order({ productOrderId: "A", ordererNo: "111", productOrderStatus: "CANCELED", paymentDate: "2026-07-07T10:00:00+09:00" }),
        order({ productOrderId: "B", ordererNo: null, ordererId: null, paymentDate: "2026-07-08T10:00:00+09:00" }),
      ],
    );
    expect(map.get("sc-r2")).toBeUndefined();
  });
});

describe("지문 병합 집계 — 스냅샷 만료 회차의 재구매 부활 (김본명 보조배터리 시나리오)", () => {
  // 1회차(2월): 스냅샷 만료 → 주문 없음, 지문만 존재. 2회차(7월): 스냅샷 주문 있음.
  const round1 = campaign("sc-r1", "2026-02-15T00:00:00+09:00", "2026-02-18T23:59:59+09:00", "oc-r1");
  const round2 = campaign("sc-r2", "2026-07-06T00:00:00+09:00", "2026-07-11T23:59:59+09:00", "oc-r2");
  const r2Orders = [
    order({ productOrderId: "A", ordererNo: "111", paymentDate: "2026-07-07T10:00:00+09:00" }), // 1회차 이력자
    order({ productOrderId: "B", ordererNo: "222", paymentDate: "2026-07-08T10:00:00+09:00" }), // 신규
  ];
  const r1Fingerprints: BuyerFingerprintRow[] = [
    { salesCampaignId: "sc-r1", buyerHash: hashBuyerKey("111") },
    { salesCampaignId: "sc-r1", buyerHash: hashBuyerKey("333") }, // 1회차만 산 사람
  ];

  it("지문 없이는(현행 한계 재현) 회차간 재구매 0", () => {
    const res = computeCrossCampaignRepurchase([round1, round2], r2Orders);
    expect(res.crossCampaignBuyers).toBe(0);
  });

  it("지문 병합 시 1회차 구매자가 부활해 회차간 재구매가 잡힌다", () => {
    const res = computeCrossCampaignRepurchase([round1, round2], r2Orders, r1Fingerprints);
    expect(res.eventsWithOrders).toBe(2);
    expect(res.totalBuyers).toBe(3); // 111, 222, 333
    expect(res.crossCampaignBuyers).toBe(1); // 111만 두 회차
  });

  it("회차별 재구매 고객(returning) 비율에도 지문이 반영된다 — 2회차 구매자 2명 중 1명(50%)", () => {
    const perEvent = computeEventReturningBuyers([round1, round2], r2Orders, r1Fingerprints);
    const r2 = perEvent.get(1)!; // 이벤트 인덱스: 시작일 순 → 1회차=0, 2회차=1
    expect(r2.buyers).toBe(2);
    expect(r2.returningBuyers).toBe(1);
    expect(r2.returningRatio).toBeCloseTo(50);
  });

  it("스냅샷과 지문에 같은 구매자가 있으면 이중 계상 없이 dedup된다", () => {
    // 2회차가 아직 스냅샷 창 안이라 지문도 이미 저장된 상태(크론 증분) — 합집합이어야 함
    const r2AlsoFingerprinted: BuyerFingerprintRow[] = [
      ...r1Fingerprints,
      { salesCampaignId: "sc-r2", buyerHash: hashBuyerKey("111") },
      { salesCampaignId: "sc-r2", buyerHash: hashBuyerKey("222") },
    ];
    const res = computeCrossCampaignRepurchase([round1, round2], r2Orders, r2AlsoFingerprinted);
    expect(res.totalBuyers).toBe(3);
    expect(res.crossCampaignBuyers).toBe(1);
  });

  it("지문은 개수 집계에만 쓰이고 결과에 해시/식별자가 노출되지 않는다(§0-1)", () => {
    const res = computeCrossCampaignRepurchase([round1, round2], r2Orders, r1Fingerprints);
    const json = JSON.stringify(res);
    expect(json).not.toContain(hashBuyerKey("111"));
    expect(json).not.toContain("111");
  });
});
