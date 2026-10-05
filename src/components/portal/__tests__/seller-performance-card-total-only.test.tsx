// @vitest-environment jsdom
// 성과 카드(F2) — 수동 정산 기준액 캠페인(오너 확정 2026-10-06)은 누적 매출(= 기준액) 한 값만
// 보인다. 우리 판매분이 섞인 주문·수량·판매일수·유입·베스트 구성은 그리지 않는다. 금액은 가공(P0).
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SellerPerformanceCard } from "../seller-performance-card";

const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@/app/order-converter/api/campaigns/campaigns-handler", () => ({ fetchAndSyncCampaigns: mockFetch }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ asset: { findMany: vi.fn(async () => []) } }) }));
vi.mock("@/lib/cached-portal-data", () => ({
  getCachedSellerRepurchase: vi.fn(async () => ({ crossCampaignBuyers: 0, returningByOrderCampaign: {} })),
}));

function orderCampaign(salesCampaign: Record<string, unknown>) {
  return {
    id: "oc-1",
    name: "가을 공구",
    salePeriod: "2026.07.01 ~ 2026.07.10",
    isActive: true,
    totalOrders: 40,
    distinctOrderCount: 37,
    totalQuantity: 55,
    totalRevenue: 3_000_000,
    dailyStats: [{ date: "2026-07-02", orders: 3, quantity: 4, revenue: 400_000, options: [{ name: "구성 A", price: 1, quantity: 4, revenue: 400_000 }] }],
    insights: { inflow: [{ path: "마케팅링크", orders: 7 }], hourly: [{ hour: 20, orders: 5 }], device: { mobile: 1, pc: 0, unknown: 0 } },
    salesCampaigns: [{ id: "sc-1", sellerId: "seller-1", ...salesCampaign }],
  };
}

async function renderCard(salesCampaign: Record<string, unknown>) {
  mockFetch.mockResolvedValue({ json: async () => [orderCampaign(salesCampaign)] });
  const ui = await SellerPerformanceCard({
    seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
    campaignId: "oc-1",
    basePath: "/p/token",
  });
  return render(ui).container.textContent ?? "";
}

describe("SellerPerformanceCard — 합계만 보이는 캠페인", () => {
  it("기준액이 적용되면 누적 매출 = 기준액, 주문·수량·유입·베스트 구성 없음", async () => {
    const text = await renderCard({ actualSales: 3_000_000, sellerFeeBasisOverride: 2_800_000, sellerMarginRate: 10 });
    expect(text).toContain("2,800,000원");
    for (const hidden of ["3,000,000", "주문 37건", "수량", "일 판매", "내 채널 유입", "베스트 구성", "피크 시간대"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("기준액이 없으면 종전 그대로", async () => {
    const text = await renderCard({});
    expect(text).toContain("3,000,000원");
    expect(text).toContain("주문 37건");
    expect(text).toContain("베스트 구성");
  });
});
