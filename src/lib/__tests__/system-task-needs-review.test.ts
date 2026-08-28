import { describe, expect, it } from "vitest";
import { parseNeedsReviewDetail } from "@/lib/system-task-needs-review";

/** prod 실측 payload(2026-08-07)의 형태를 그대로 축약한 것 — 실명은 뺐다(P0). */
function realShapedItem(overrides: Record<string, unknown> = {}) {
  return {
    key: "cmp1:ISSUE:supplierInvoiceIssuedAt",
    campaignLabel: "딜명 - 셀러",
    counterpartLabel: "거래처",
    channel: "BRAND_MALL",
    trackingField: "supplierInvoiceIssuedAt",
    reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다" }],
    observed: { amountDelta: 1000 },
    ...overrides,
  };
}

describe("parseNeedsReviewDetail", () => {
  it("실제 크론 payload 형태에서 항목을 뽑고 채널을 한국어로 옮긴다", () => {
    const parsed = parseNeedsReviewDetail({
      needsReview: 1,
      needsReviewDetail: [realShapedItem()],
      needsReviewDetailCapped: false,
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      key: "cmp1:ISSUE:supplierInvoiceIssuedAt",
      campaignLabel: "딜명 - 셀러",
      counterpartLabel: "거래처",
      channelLabel: "브랜드몰",
    });
    expect(parsed.items[0].reasons).toEqual([{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다" }]);
    expect(parsed.capped).toBe(false);
  });

  it("원본 채널 enum 을 화면으로 흘리지 않는다", () => {
    const parsed = parseNeedsReviewDetail({ needsReviewDetail: [realShapedItem()] });
    expect(parsed.items[0].channelLabel).not.toBe("BRAND_MALL");
  });

  it("모르는 채널 값은 버리지 않고 원문 그대로 남긴다", () => {
    const parsed = parseNeedsReviewDetail({
      needsReviewDetail: [realShapedItem({ channel: "FUTURE_CHANNEL" })],
    });
    expect(parsed.items[0].channelLabel).toBe("FUTURE_CHANNEL");
  });

  it("capped 를 그대로 전달한다 — 화면이 '이게 전부'라고 말하지 않게", () => {
    const parsed = parseNeedsReviewDetail({
      needsReviewDetail: [realShapedItem()],
      needsReviewDetailCapped: true,
    });
    expect(parsed.capped).toBe(true);
  });

  it("잘렸을 때 총계는 집계 필드를 쓴다 — 실린 건수를 총계로 되쓰지 않는다", () => {
    const parsed = parseNeedsReviewDetail({
      needsReview: 9,
      needsReviewDetail: [realShapedItem()],
      needsReviewDetailCapped: true,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(9);
  });

  it("집계 필드가 실린 항목보다 작으면(모순) 항목 수를 쓴다 — 화면이 과소보고하지 않게", () => {
    const parsed = parseNeedsReviewDetail({
      needsReview: 0,
      needsReviewDetail: [realShapedItem(), realShapedItem({ key: "cmp2:ISSUE:x" })],
    });
    expect(parsed.total).toBe(2);
  });

  it("집계 필드가 없으면 항목 수가 총계", () => {
    expect(parseNeedsReviewDetail({ needsReviewDetail: [realShapedItem()] }).total).toBe(1);
  });

  it("사유가 없는 항목은 버린다 — 판단 가치 없는 빈 줄 금지(P2)", () => {
    const parsed = parseNeedsReviewDetail({
      needsReviewDetail: [realShapedItem({ reasons: [] }), realShapedItem({ reasons: [{ code: "X" }] })],
    });
    expect(parsed.items).toEqual([]);
  });

  it("details 가 절단되면(truncated preview) 빈 결과 — 반쯤 복원하지 않는다", () => {
    const parsed = parseNeedsReviewDetail({
      truncated: true,
      preview: JSON.stringify({ needsReviewDetail: [realShapedItem()] }).slice(0, 120),
    });
    expect(parsed).toEqual({ items: [], total: 0, capped: false });
  });

  it("needsReviewDetail 규약이 없는 잡의 details 는 빈 결과", () => {
    expect(parseNeedsReviewDetail({ ok: true, collected: 12 }).items).toEqual([]);
  });

  it("null·문자열·배열 등 비객체 details 에서 터지지 않는다", () => {
    for (const input of [null, undefined, "text", 42, [realShapedItem()]]) {
      expect(parseNeedsReviewDetail(input)).toEqual({ items: [], total: 0, capped: false });
    }
  });

  it("항목 배열 안의 쓰레기 값은 건너뛰고 성한 항목만 남긴다", () => {
    const parsed = parseNeedsReviewDetail({
      needsReviewDetail: [null, "x", { reasons: [] }, realShapedItem()],
    });
    expect(parsed.items).toHaveLength(1);
  });
});
