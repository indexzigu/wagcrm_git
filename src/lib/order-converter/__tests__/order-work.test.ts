import { describe, expect, it } from "vitest";
import {
  CONFIRM_DELAY_WARN_DAYS,
  PENDING_DELAY_WARN_DAYS,
  SHIPPING_DELAY_WARN_DAYS,
  classifyOrderWork,
  summarizeOrderWork,
  type OrderWorkClassification,
} from "../order-work";

// 「이 주문에 오늘 손이 가야 하는가」 판정 SSOT — 주문 관리 카드의 지연 배지와 홈 「오늘 처리할 주문」이
// 같은 함수를 쓴다. ⏰ 고정 날짜 대신 now 기준 상대 시각으로 만든다(P9 시한폭탄 규칙).
const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (n: number, extraMs = 0) => NOW - n * DAY - extraMs;

function classify(overrides: Partial<Parameters<typeof classifyOrderWork>[0]>) {
  return classifyOrderWork({
    productOrderStatus: "PAYED",
    placeOrderStatus: "NOT_YET",
    poRequestedAt: null,
    orderTimeMs: daysAgo(0),
    nowMs: NOW,
    ...overrides,
  });
}

describe("classifyOrderWork — 버킷", () => {
  it("결제 완료 · 발주확인 전 → newBefore(지연 경고 없음 — 미확인은 경과일로 경고하지 않는다)", () => {
    expect(classify({ orderTimeMs: daysAgo(10) })).toEqual({ bucket: "newBefore", delayDays: null });
  });

  it("발주확인 후 발주요청 전 → newAfter", () => {
    expect(classify({ placeOrderStatus: "OK" }).bucket).toBe("newAfter");
    expect(classify({ productOrderStatus: "PRODUCT_ORDERED", placeOrderStatus: null }).bucket).toBe("newAfter");
  });

  it("발주요청 기록이 있으면 네이버 상태보다 우선해 pending(배송대기)", () => {
    expect(classify({ placeOrderStatus: "OK", poRequestedAt: new Date(daysAgo(0)) }).bucket).toBe("pending");
  });

  it("배송중·배송완료·무효 상태는 발주요청 기록과 무관하게 그 상태를 따른다", () => {
    const po = new Date(daysAgo(9));
    expect(classify({ productOrderStatus: "DELIVERING", poRequestedAt: po }).bucket).toBe("shipping");
    expect(classify({ productOrderStatus: "DELIVERED", poRequestedAt: po })).toEqual({ bucket: "completed", delayDays: null });
    expect(classify({ productOrderStatus: "CANCELED", poRequestedAt: po })).toEqual({ bucket: "other", delayDays: null });
  });
});

describe("classifyOrderWork — 지연 경고 임계값", () => {
  it("주문확인 후 발주 지연: 결제 후 2일부터 경고", () => {
    expect(CONFIRM_DELAY_WARN_DAYS).toBe(2);
    expect(classify({ placeOrderStatus: "OK", orderTimeMs: daysAgo(2, -60_000) }).delayDays).toBeNull();
    expect(classify({ placeOrderStatus: "OK", orderTimeMs: daysAgo(2) }).delayDays).toBe(2);
  });

  it("송장 미회신: 결제가 아니라 발주요청 시각부터 2일", () => {
    expect(PENDING_DELAY_WARN_DAYS).toBe(2);
    // 결제는 10일 전이어도 발주요청이 어제면 경고하지 않는다(시계가 발주요청 시각이다).
    expect(classify({ orderTimeMs: daysAgo(10), poRequestedAt: new Date(daysAgo(1)) }).delayDays).toBeNull();
    expect(classify({ orderTimeMs: daysAgo(10), poRequestedAt: new Date(daysAgo(3)) }).delayDays).toBe(3);
  });

  it("배송중 지연: 결제 후 5일부터 경고", () => {
    expect(SHIPPING_DELAY_WARN_DAYS).toBe(5);
    expect(classify({ productOrderStatus: "DELIVERING", orderTimeMs: daysAgo(4) }).delayDays).toBeNull();
    expect(classify({ productOrderStatus: "DELIVERING", orderTimeMs: daysAgo(5) }).delayDays).toBe(5);
  });

  it("결제 시각을 모르면(0) 경과일로 경고하지 않는다", () => {
    expect(classify({ placeOrderStatus: "OK", orderTimeMs: 0 }).delayDays).toBeNull();
    expect(classify({ productOrderStatus: "DELIVERING", orderTimeMs: 0 }).delayDays).toBeNull();
  });
});

describe("summarizeOrderWork", () => {
  const w = (bucket: OrderWorkClassification["bucket"], delayDays: number | null = null): OrderWorkClassification => ({
    bucket,
    delayDays,
  });

  it("전부 0 이면 total 0 — 홈 카드가 조용한 한 줄로 물러나는 조건", () => {
    expect(summarizeOrderWork([], [])).toEqual({
      awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
      delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
      openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
      total: 0,
    });
  });

  it("발주 대기 = 주문확인 칸(미확인 + 발주확인 후). 그중 2일 넘은 건을 따로 센다", () => {
    const summary = summarizeOrderWork(
      [
        { campaignId: "a", classifications: [w("newBefore"), w("newAfter", 3), w("completed")] },
        { campaignId: "b", classifications: [w("newAfter")] },
        { campaignId: "c", classifications: [w("completed"), w("other")] },
      ],
      [],
    );
    expect(summary.awaitingPo).toEqual({ lines: 3, campaigns: 2, delayedLines: 1 });
    expect(summary.total).toBe(3);
  });

  it("배송 지연 = 경고 걸린 배송대기·배송중만. 경고 없는 배송대기·배송중은 일이 아니다", () => {
    const summary = summarizeOrderWork(
      [
        { campaignId: "a", classifications: [w("pending", 2), w("pending"), w("shipping")] },
        { campaignId: "b", classifications: [w("shipping", 6), w("shipping", 9)] },
      ],
      [],
    );
    expect(summary.delayed).toEqual({ lines: 3, campaigns: 2, invoiceLines: 1, shippingLines: 2 });
    expect(summary.awaitingPo.lines).toBe(0);
  });

  it("진행 중 클레임 — 캠페인 수는 귀속된 캠페인 이름 기준, 미매칭은 건수에만 들어간다", () => {
    const summary = summarizeOrderWork(
      [],
      [{ matchedCampaignName: "가" }, { matchedCampaignName: "가" }, { matchedCampaignName: "나" }, { matchedCampaignName: null }],
    );
    expect(summary.openClaims).toEqual({ lines: 4, campaigns: 2, unmatchedLines: 1 });
    expect(summary.total).toBe(4);
  });

  it("total = 세 칸의 합(배지 숫자)", () => {
    const summary = summarizeOrderWork(
      [{ campaignId: "a", classifications: [w("newBefore"), w("pending", 4)] }],
      [{ matchedCampaignName: "가" }],
    );
    expect(summary.total).toBe(3);
  });
});
