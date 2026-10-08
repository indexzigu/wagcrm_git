// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SellerPortalReport } from "./seller-portal-report";

const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@/app/order-converter/api/campaigns/campaigns-handler", () => ({
  fetchAndSyncCampaigns: mockFetch,
}));

// KST 달력일 YYYY-MM-DD(오프셋 일수 적용) — 컴포넌트의 todayKstKey와 같은 기준으로 계산해
// 실시계 의존 테스트를 실행 시점과 무관하게 결정론적으로 만든다.
function kstYmd(offsetDays = 0): string {
  const base = new Date(Date.now() + 9 * 3600 * 1000);
  const t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()) + offsetDays * 86_400_000;
  return new Date(t).toISOString().split("T")[0];
}

beforeEach(() => {
  // 기본값: 종료된 캠페인만(active=[]) — §0-1 과거·정산 미노출 검증용
  mockFetch.mockResolvedValue({
    headers: { get: () => null },
    json: async () => [
      {
        id: "oc-history-only",
        name: "종료된 캠페인",
        salePeriod: "2026.06.01 ~ 2026.06.10",
        isActive: false,
        totalOrders: 12,
        distinctOrderCount: 8,
        totalQuantity: 15,
        totalRevenue: 1_000_000,
        dailyStats: [],
        insights: null,
        salesCampaigns: [{ id: "sc-history-only", sellerId: "seller-1" }],
      },
    ],
  });
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    asset: {
      findMany: vi.fn(async () => []),
    },
  }),
}));

vi.mock("@/lib/cached-portal-data", () => ({
  getCachedSellerRepurchase: vi.fn(async () => ({
    crossCampaignBuyers: 0,
    returningByOrderCampaign: {},
  })),
}));

describe("SellerPortalReport", () => {
  it("does not expose past campaign or settlement history on the seller-facing report", async () => {
    const ui = await SellerPortalReport({
      seller: {
        id: "seller-1",
        name: "셀러",
        alias: null,
        currentFollowers: 1000,
      },
      basePath: "/p/token",
    });

    render(ui);

    expect(screen.getByText("현재 공유 중인 캠페인 리포트가 없습니다.")).toBeTruthy();
    expect(screen.queryByText("지난 캠페인 · 정산 내역")).toBeNull();
    expect(screen.queryByText("정산금")).toBeNull();
    expect(screen.queryByText("거래액")).toBeNull();
  });

  // §3 실시간 지표 — 진행중 캠페인 카드에 전일 대비 모멘텀이 렌더되는지.
  // 마감이 4일 이상 남은 건은 **아무 마감 표기도 하지 않는다**(오너 지시 2026-08-26,
  // 판매 마감에는 디데이를 쓰지 않는다). 재유입 방지용 역단언을 함께 둔다.
  it("진행중 캠페인에 판매 마감 D-day 없이 전일 대비 증감(모멘텀)만 표시한다", async () => {
    const today = kstYmd(0);
    const yesterday = kstYmd(-1);
    const end = kstYmd(5).replace(/-/g, "."); // 마감 5일 뒤 = 라이브 문턱(3일) 밖 → 표기 없음
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [
        {
          id: "oc-active",
          name: "진행중 캠페인",
          salePeriod: `2026.07.01 ~ ${end}`,
          isActive: true,
          totalOrders: 20,
          distinctOrderCount: 18,
          totalQuantity: 25,
          totalRevenue: 3_000_000,
          dailyStats: [
            { date: yesterday, orders: 5, quantity: 6, revenue: 100_000, options: [] },
            { date: today, orders: 10, quantity: 12, revenue: 200_000, options: [] },
          ],
          insights: null,
          salesCampaigns: [{ id: "sc-active", sellerId: "seller-1" }],
        },
      ],
    });

    const ui = await SellerPortalReport({
      seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
      basePath: "/p/token",
    });
    render(ui);

    expect(screen.getByText("판매중")).toBeTruthy();
    // 판매 마감 D-day 는 폐기됐다 — 5일 남은 건에는 어떤 마감 표기도 없어야 한다.
    expect(screen.queryByText("D-5")).toBeNull();
    expect(screen.queryByText(/^D-\d+$/)).toBeNull();
    // 전일 100,000 → 오늘 200,000 = +100% 상승 모멘텀
    expect(screen.getByText(/▲\s*100%/)).toBeTruthy();
  });

  // §예정 섹션 — 시작일이 미래인 활성 캠페인은 "판매중"이 아니라 "예정" 섹션에 오픈 카운트다운으로.
  it("시작일이 미래인 활성 캠페인은 '판매중'이 아니라 '예정'으로 분리 노출한다", async () => {
    const start = kstYmd(5).replace(/-/g, "."); // 5일 뒤 오픈 → 정적 "D-5 오픈예정"(라이브 미마운트)
    const end = kstYmd(12).replace(/-/g, ".");
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [
        {
          id: "oc-upcoming",
          name: "예정 캠페인",
          salePeriod: `${start} ~ ${end}`,
          isActive: true,
          totalOrders: 0,
          distinctOrderCount: 0,
          totalQuantity: 0,
          totalRevenue: 0,
          dailyStats: [],
          insights: null,
          salesCampaigns: [{ id: "sc-upcoming", sellerId: "seller-1" }],
        },
      ],
    });

    const ui = await SellerPortalReport({
      seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
      basePath: "/p/token",
    });
    render(ui);

    expect(screen.getByText("예정 캠페인")).toBeTruthy();
    expect(screen.getByText("D-5 오픈예정")).toBeTruthy(); // 오픈까지 정적 배지
    // 상태 낱말은 붙여 쓴 한 낱말(오너 확정 2026-10-08) — 칩 「판매예정」, 기간 줄은 값만(상태 낱말 중복 없음).
    expect(screen.getByText("판매예정")).toBeTruthy();
    expect(screen.getByText(`${start} ~ ${end}`)).toBeTruthy();
    expect(screen.queryByText(/오픈 예정/)).toBeNull();
    expect(screen.queryByText("판매중")).toBeNull(); // 오픈 전인데 판매중으로 잘못 뜨지 않음
    expect(screen.queryByText("현재 공유 중인 캠페인 리포트가 없습니다.")).toBeNull();
  });

  // 마감이 지난 활성 캠페인 — 정적 상태 배지 「판매종료」(붙여 쓴 한 낱말, 오너 확정 2026-10-08).
  it("마감이 지난 캠페인은 칩이 「판매종료」를 말하고 「판매중」과 겹쳐 보이지 않는다", async () => {
    const start = kstYmd(-10).replace(/-/g, ".");
    const end = kstYmd(-1).replace(/-/g, ".");
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [
        {
          id: "oc-ended",
          name: "종료 캠페인",
          salePeriod: `${start} ~ ${end}`,
          isActive: true,
          totalOrders: 1,
          distinctOrderCount: 1,
          totalQuantity: 1,
          totalRevenue: 10000,
          dailyStats: [],
          insights: null,
          salesCampaigns: [{ id: "sc-ended", sellerId: "seller-1" }],
        },
      ],
    });

    const ui = await SellerPortalReport({
      seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
      basePath: "/p/token",
    });
    render(ui);

    // 칩 하나만 「판매종료」를 말한다 — 같은 말을 되풀이하던 배지는 그리지 않는다(모순·중복 제거).
    expect(screen.getAllByText("판매종료")).toHaveLength(1);
    expect(screen.queryByText("판매중")).toBeNull();
    expect(screen.queryByText("판매 종료")).toBeNull();
  });

  // §B+D — 마감 임박(≤3일)이면 라이브 카운트다운 클라이언트 island가 마운트돼 시:분:초로 렌더된다.
  it("마감 임박 캠페인은 라이브 카운트다운(시:분:초)으로 렌더된다", async () => {
    const start = kstYmd(-3).replace(/-/g, ".");
    const end = kstYmd(1).replace(/-/g, "."); // 내일 마감 → 라이브(amber)
    mockFetch.mockResolvedValue({
      headers: { get: () => null },
      json: async () => [
        {
          id: "oc-imminent",
          name: "임박 캠페인",
          salePeriod: `${start} ~ ${end}`,
          isActive: true,
          totalOrders: 1,
          distinctOrderCount: 1,
          totalQuantity: 1,
          totalRevenue: 10000,
          dailyStats: [],
          insights: null,
          salesCampaigns: [{ id: "sc-imminent", sellerId: "seller-1" }],
        },
      ],
    });

    const ui = await SellerPortalReport({
      seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
      basePath: "/p/token",
    });
    render(ui);

    expect(screen.getByText("판매중")).toBeTruthy();
    // useEffect가 초기 정적 라벨을 라이브 시:분:초로 업그레이드 → HH:MM:SS 패턴 노출(마운트 정상)
    expect(screen.getByText(/\d{2}:\d{2}:\d{2}/)).toBeTruthy();
  });
});

// 수동 정산 기준액 캠페인(오너 확정 2026-10-06) — 셀러 화면에는 합계(= 기준액) 한 값만 나간다.
// 우리 판매분이 섞인 주문 파생 상세(일별·구성별 매출, 수량·주문 수, 유입 지표)는 비어서 오고,
// 화면은 빈 칸·「-」·조정 안내 없이 합계 한 칸만 그린다. 금액은 가공이다(P0).
describe("SellerPortalReport — 합계만 보이는 캠페인", () => {
  function activeCampaign(salesCampaigns: Array<Record<string, unknown>>) {
    const today = kstYmd(0);
    const end = kstYmd(5).replace(/-/g, ".");
    return {
      id: "oc-basis",
      name: "가을 공구",
      salePeriod: `2026.07.01 ~ ${end}`,
      isActive: true,
      totalOrders: 20,
      distinctOrderCount: 18,
      totalQuantity: 25,
      totalRevenue: 3_000_000,
      dailyStats: [
        { date: today, orders: 10, quantity: 12, revenue: 1_234_000, options: [{ name: "구성 A", price: 1, quantity: 12, revenue: 1_234_000 }] },
      ],
      insights: {
        inflow: [{ path: "마케팅링크", orders: 7 }],
        hourly: [{ hour: 20, orders: 5 }],
        device: { mobile: 9, pc: 1, unknown: 0 },
      },
      salesCampaigns,
    };
  }

  async function renderWith(salesCampaigns: Array<Record<string, unknown>>) {
    mockFetch.mockResolvedValue({ headers: { get: () => null }, json: async () => [activeCampaign(salesCampaigns)] });
    const ui = await SellerPortalReport({
      seller: { id: "seller-1", name: "셀러", alias: null, currentFollowers: 1000 },
      basePath: "/p/token",
    });
    return render(ui);
  }

  it("기준액이 적용되면 누적 매출(기준액) 한 칸만 — 오늘 매출·주문/수량·구성별·일자별·유입 지표 없음", async () => {
    const { container } = await renderWith([
      { id: "sc-1", sellerId: "seller-1", actualSales: 3_000_000, sellerFeeBasisOverride: 2_800_000, sellerMarginRate: 10 },
    ]);
    const text = container.textContent ?? "";
    expect(screen.getByText("누적 매출")).toBeTruthy();
    expect(text).toContain("2,800,000");
    for (const hidden of ["3,000,000", "1,234,000", "오늘 매출", "주문 18건", "수량", "구성별 판매", "일자별 현황", "링크 유입", "시간대별 주문"]) {
      expect(text).not.toContain(hidden);
    }
    // 머리 칸에는 「누적 매출 + 금액」만 — 자리표시 「-」·빈 칸 없음.
    expect(screen.getByTestId("portal-headline").textContent).toBe("누적 매출2,800,000원");
    for (const hint of ["기준액", "조정", "직접 입력", "수동"]) expect(text).not.toContain(hint);
  });

  it("기준액이 없으면 종전 그대로(오늘 매출·주문/수량·일자별 표시)", async () => {
    const { container } = await renderWith([{ id: "sc-1", sellerId: "seller-1" }]);
    const text = container.textContent ?? "";
    expect(text).toContain("3,000,000");
    expect(text).toContain("오늘 매출");
    expect(text).toContain("주문 18건");
    expect(text).toContain("일자별 현황");
  });

  it("품목 요율이 섞여 기준액이 적용되지 않으면 종전 그대로(writer 와 같은 판정)", async () => {
    const { container } = await renderWith([
      {
        id: "sc-1",
        sellerId: "seller-1",
        actualSales: 3_000_000,
        sellerFeeBasisOverride: 2_800_000,
        sellerMarginRate: 10,
        campaignDeals: [{ sellerMarginRate: 10 }, { sellerMarginRate: 20 }],
      },
    ]);
    expect(container.textContent).toContain("3,000,000");
    expect(container.textContent).not.toContain("2,800,000");
  });
});
