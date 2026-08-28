import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileHomePulseCard } from "../mobile-home-pulse-card";
import { MobileTodaySummaryBar } from "../mobile-today-summary-bar";
import type { MobilePulseResponse } from "@/lib/mobile-pulse-data";

function makePulse(overrides: Partial<MobilePulseResponse> = {}): MobilePulseResponse {
  return {
    asOf: "2026-07-15T05:00:00.000Z",
    today: { orders: 8, quantity: 15, revenue: 1_240_000 },
    cumulative: { orders: 340, quantity: 400, revenue: 38_200_000 },
    byCampaign: [
      { campaignId: "camp-1", dealName: "비타민C 앰플", sellerName: "하늘맘", todayOrders: 3, todayRevenue: 312_000 },
      { campaignId: "camp-2", dealName: "콜라겐 젤리", sellerName: "봄날셀러", todayOrders: 2, todayRevenue: 210_000 },
      { campaignId: "camp-3", dealName: "유산균 스틱", sellerName: "숲속댁", todayOrders: 1, todayRevenue: 99_000 },
      { campaignId: "camp-4", dealName: "오메가3", sellerName: "바다맘", todayOrders: 1, todayRevenue: 55_000 },
    ],
    fulfillment: { ordered: 12, shipping: 5, completed: 23 },
    ...overrides,
  };
}

function stubFetch(payload: MobilePulseResponse) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// 테스트마다 새 QueryClient(retry 끔) — 캐시 누수·재시도 지연 없이 결정론적으로 돈다.
function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  stubFetch(makePulse());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobileHomePulseCard (홈 재구성 안 C — 오너 승인 2026-07-15)", () => {
  it("오늘 매출·오늘 주문 2칸 스탯을 렌더한다", async () => {
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => expect(screen.getByText("오늘 매출")).toBeInTheDocument());
    expect(screen.getByText("₩1,240,000")).toBeInTheDocument();
    expect(screen.getByText("오늘 주문")).toBeInTheDocument();
    expect(screen.getByText("8건")).toBeInTheDocument();
  });

  it("byCampaign 상위 3건만 딜명·셀러명·오늘 매출로 노출한다(4번째 행 제외)", async () => {
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => expect(screen.getByText("비타민C 앰플")).toBeInTheDocument());
    expect(screen.getByText("하늘맘")).toBeInTheDocument();
    expect(screen.getByText("₩312,000")).toBeInTheDocument();
    expect(screen.getByText("콜라겐 젤리")).toBeInTheDocument();
    expect(screen.getByText("유산균 스틱")).toBeInTheDocument();
    // 4번째 캠페인은 상위 3건 밖 — 미노출
    expect(screen.queryByText("오메가3")).not.toBeInTheDocument();
  });

  it("오늘 주문 0건 캠페인은 리스트에서 제외하고, 전부 0건이면 빈 문구를 보여준다", async () => {
    stubFetch(
      makePulse({
        byCampaign: [
          { campaignId: "camp-1", dealName: "비타민C 앰플", sellerName: "하늘맘", todayOrders: 0, todayRevenue: 0 },
        ],
      }),
    );
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => expect(screen.getByText("오늘 매출")).toBeInTheDocument());
    expect(screen.queryByText("비타민C 앰플")).not.toBeInTheDocument();
    expect(screen.getByText("오늘 들어온 주문이 아직 없습니다")).toBeInTheDocument();
  });

  it("마운트 시 1회만 fetch 한다(자동 폴링 금지)", async () => {
    const fetchMock = stubFetch(makePulse());
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => expect(screen.getByText("오늘 매출")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/mobile/pulse", { cache: "no-store" });
  });

  it("홈 카드와 일정 요약 바가 캐시를 공유해 한 클라이언트에서 fetch 1회로 렌더된다 (사용량 절감 계약 2026-07-23)", async () => {
    const fetchMock = stubFetch(makePulse());
    renderWithClient(
      <>
        <MobileHomePulseCard />
        <MobileTodaySummaryBar />
      </>,
    );
    await waitFor(() => expect(screen.getByText("오늘 매출")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("배송중")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("새로고침 버튼으로 수동 재조회한다", async () => {
    const fetchMock = stubFetch(makePulse());
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => expect(screen.getByText("오늘 매출")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "오늘의 펄스 새로고침" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("펄스 실패 시 실패 문구를 명시한다(에러 삼킴 금지)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithClient(<MobileHomePulseCard />);
    await waitFor(() => {
      expect(screen.getByText("오늘의 펄스를 불러오지 못했습니다")).toBeInTheDocument();
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
