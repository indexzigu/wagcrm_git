// @vitest-environment jsdom
// 셀러 단일성 게이트 계약 — 한 주문캠페인(OrderCampaign)에 **서로 다른 셀러**의 판매캠페인이
// 붙었을 때 셀러 대면 표면이 OC 단위 합산을 노출하지 않는지 고정한다.
//
// 왜 이 픽스처가 가드의 핵심인가:
// 포털 화이트리스트(toPortalCampaign)는 **필드** 축은 완벽히 막지만 **집계 범위** 축은 못 막는다
// — totalRevenue·distinctOrderCount·dailyStats·insights 는 campaigns-handler 가 OrderCampaign
// 단위로 계산하고(그 루프에 sellerId 필터가 없다), 포털은 salesCampaigns 중 하나라도 이 셀러
// 것이면 캠페인 전체 집계를 보여줬다. 즉 셀러 A 화면에 A+B 합산이 A 의 실적으로 표시된다
// (AGENTS.md P0 「Seller-Facing Data Exposure」 위반).
// 기존 테스트 픽스처는 전부 sellerId 가 하나뿐이라 이 경로를 한 번도 통과시키지 않았다.
//
// ⚠️ 음성 대조군을 반드시 함께 고정한다 — **같은 셀러의 판매캠페인 여러 행**(딜마다 1행이
// 생기는 정상 1:N 운영, 실측 OC당 최대 5행)은 계속 보여야 한다. 게이트가 행 수를 세면
// 정상 캠페인이 통째로 사라진다.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  countLinkedSellers,
  isCrossSellerCampaign,
  selectSellerVisibleCampaigns,
} from "@/lib/seller-portal";
import { SellerPortalReport } from "../seller-portal-report";
import { SellerPerformanceCard } from "../seller-performance-card";

const mockFetch = vi.hoisted(() => vi.fn());
const NOT_FOUND = "NEXT_NOT_FOUND";

vi.mock("@/app/order-converter/api/campaigns/campaigns-handler", () => ({
  fetchAndSyncCampaigns: mockFetch,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ asset: { findMany: vi.fn(async () => []) } }),
}));

vi.mock("@/lib/cached-portal-data", () => ({
  getCachedSellerRepurchase: vi.fn(async () => ({
    crossCampaignBuyers: 0,
    returningByOrderCampaign: {},
  })),
}));

const SELLER = { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 };

// OC 단위 합산이 화면에 새면 이 숫자가 그대로 렌더된다 — 탐지용 지문.
const LEAKED_REVENUE = 987_654_321;
const LEAKED_ORDERS = 4321;

function campaignWith(salesCampaigns: { id: string; sellerId: string }[]) {
  return {
    id: "oc-shared",
    name: "공유 주문캠페인",
    salePeriod: "2026.07.01 ~ 2026.12.31",
    isActive: true,
    totalOrders: LEAKED_ORDERS,
    distinctOrderCount: LEAKED_ORDERS,
    totalQuantity: 100,
    totalRevenue: LEAKED_REVENUE,
    dailyStats: [],
    insights: null,
    salesCampaigns,
  };
}

/** 서로 다른 셀러 2건 — 이 가드가 막아야 하는 상태 */
const CROSS_SELLER = campaignWith([
  { id: "sc-mine", sellerId: "seller-1" },
  { id: "sc-other", sellerId: "seller-2" },
]);

/** 같은 셀러 여러 행(딜별 1행) — 정상 1:N. 막으면 안 되는 상태 */
const SAME_SELLER_MULTI_ROW = campaignWith([
  { id: "sc-deal-a", sellerId: "seller-1" },
  { id: "sc-deal-b", sellerId: "seller-1" },
  { id: "sc-deal-c", sellerId: "seller-1" },
]);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.clearAllMocks();
});

describe("셀러 단일성 판정(순수 함수)", () => {
  it("서로 다른 sellerId 2건을 교차 셀러로 판정한다", () => {
    expect(countLinkedSellers(CROSS_SELLER)).toBe(2);
    expect(isCrossSellerCampaign(CROSS_SELLER)).toBe(true);
  });

  it("같은 셀러의 여러 판매캠페인 행(정상 1:N)은 교차 셀러가 아니다", () => {
    expect(countLinkedSellers(SAME_SELLER_MULTI_ROW)).toBe(1);
    expect(isCrossSellerCampaign(SAME_SELLER_MULTI_ROW)).toBe(false);
  });

  it("sellerId 가 비어 있는 연결은 귀속 불가라 세지 않는다", () => {
    const camp = campaignWith([{ id: "sc-mine", sellerId: "seller-1" }]);
    (camp.salesCampaigns as any[]).push({ id: "sc-null", sellerId: null });
    expect(countLinkedSellers(camp)).toBe(1);
    expect(isCrossSellerCampaign(camp)).toBe(false);
  });

  it("교차 셀러 캠페인을 visible 에서 빼고 blocked 로 분리한다", () => {
    const { visible, blocked } = selectSellerVisibleCampaigns(
      [CROSS_SELLER, SAME_SELLER_MULTI_ROW],
      "seller-1",
    );
    expect(visible.map((c) => c.salesCampaigns[0].id)).toEqual(["sc-deal-a"]);
    expect(blocked).toHaveLength(1);
  });

  it("이 셀러가 참여하지 않은 캠페인은 어느 쪽에도 담기지 않는다", () => {
    const foreign = campaignWith([{ id: "sc-x", sellerId: "seller-9" }]);
    const { visible, blocked } = selectSellerVisibleCampaigns([foreign], "seller-1");
    expect(visible).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });
});

describe("셀러 포털 리포트(/<slug> · /p/[token])", () => {
  it("교차 셀러 캠페인을 노출하지 않고 OC 단위 합산도 새지 않는다", async () => {
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [CROSS_SELLER],
    });

    render(
      await SellerPortalReport({ seller: SELLER, basePath: "/p/token" }),
    );

    expect(screen.queryByText("공유 주문캠페인")).toBeNull();
    // 합산 지문이 어떤 형태(원 표기·천단위 구분)로도 화면에 남지 않아야 한다.
    expect(document.body.textContent).not.toContain(LEAKED_REVENUE.toLocaleString());
    expect(document.body.textContent).not.toContain(LEAKED_ORDERS.toLocaleString());
    expect(screen.getByText("현재 공유 중인 캠페인 리포트가 없습니다.")).toBeTruthy();
  });

  it("표시 제외를 조용히 하지 않는다 — 운영자 경고를 남긴다(P0 No Silent Failure)", async () => {
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [CROSS_SELLER],
    });

    render(await SellerPortalReport({ seller: SELLER, basePath: "/p/token" }));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("oc-shared");
    // 경고는 식별자만 — 레포가 public 이라 실명·실측치를 로그 문구에 싣지 않는다(P0).
    expect(msg).not.toContain(String(LEAKED_REVENUE));
  });

  it("같은 셀러의 여러 판매캠페인 행(정상 1:N)은 계속 노출한다", async () => {
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [SAME_SELLER_MULTI_ROW],
    });

    render(await SellerPortalReport({ seller: SELLER, basePath: "/p/token" }));

    expect(screen.getByText("공유 주문캠페인")).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("셀러 성과 카드(/<slug>/card/[id] · /p/[token]/card/[id])", () => {
  it("교차 셀러 캠페인의 카드는 내주지 않는다", async () => {
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [CROSS_SELLER],
    });

    await expect(
      SellerPerformanceCard({
        seller: SELLER,
        campaignId: "oc-shared",
        basePath: "/p/token",
      }),
    ).rejects.toThrow(NOT_FOUND);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("oc-shared");
  });

  it("같은 셀러의 여러 판매캠페인 행(정상 1:N)은 카드를 정상 렌더한다", async () => {
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [SAME_SELLER_MULTI_ROW],
    });

    render(
      await SellerPerformanceCard({
        seller: SELLER,
        campaignId: "oc-shared",
        basePath: "/p/token",
      }),
    );

    expect(screen.getByText("공유 주문캠페인")).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
