import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAllMarketPricesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/price-monitor/market-fetch", () => ({
  fetchAllMarketPrices: (...args: unknown[]) => fetchAllMarketPricesMock(...args),
}));

import { POST } from "./route";

describe("POST /api/price-monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAllMarketPricesMock.mockResolvedValue({
      allItems: [],
      minItem: null,
      errors: { naver: null, coupang: null, kakao: null },
      sources: {
        naver: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        kakao: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
      },
    });
  });

  it("즉시 조회 응답에 소스별 상태와 조회시각을 그대로 전달한다", async () => {
    const response = await POST(
      new Request("http://localhost/api/price-monitoring", {
        method: "POST",
        body: JSON.stringify({ query: "테스트 상품" }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(await response.json()).toMatchObject({
      success: true,
      sources: {
        naver: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z" },
        coupang: { status: "disabled" },
      },
    });
  });
});
