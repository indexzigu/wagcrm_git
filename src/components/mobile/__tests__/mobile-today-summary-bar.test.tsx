import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileTodaySummaryBar } from "../mobile-today-summary-bar";
import type { MobilePulseResponse } from "@/lib/mobile-pulse-data";

function makePulse(overrides: Partial<MobilePulseResponse> = {}): MobilePulseResponse {
  return {
    asOf: "2026-07-08T05:00:00.000Z",
    today: { orders: 8, quantity: 15, revenue: 1_240_000 },
    cumulative: { orders: 340, quantity: 400, revenue: 38_200_000 },
    byCampaign: [
      {
        campaignId: "camp-1",
        dealName: "비타민C 앰플",
        sellerName: "하늘맘",
        todayOrders: 3,
        todayRevenue: 312_000,
      },
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

describe("MobileTodaySummaryBar (아코디언 제거 — 오너 피드백 2026-07-14)", () => {
  it("진행중 전 캠페인 배송 진행(주문·배송중·배송완료)을 항상 표시한다", async () => {
    renderWithClient(<MobileTodaySummaryBar />);
    await waitFor(() => {
      expect(screen.getByText("주문")).toBeInTheDocument();
    });
    // 배타 3단계 수치가 각각 노출된다
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
    expect(screen.getByText("배송중")).toBeInTheDocument();
    expect(screen.getByText("배송완료")).toBeInTheDocument();
  });

  it("아코디언(펼침 영역)이 없다 — 동기화 시간·전체 캠페인 링크 미노출", async () => {
    renderWithClient(<MobileTodaySummaryBar />);
    await waitFor(() => expect(screen.getByText("주문")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "배송 진행 현황 상세" })).not.toBeInTheDocument();
    expect(screen.queryByText(/기준/)).not.toBeInTheDocument();
    expect(screen.queryByText("전체 캠페인 보기 ›")).not.toBeInTheDocument();
    expect(screen.queryByText(/오늘 8건/)).not.toBeInTheDocument();
    expect(screen.queryByText("비타민C 앰플")).not.toBeInTheDocument();
  });

  it("새로고침 버튼이 인라인으로 남아 수동 재조회를 트리거한다", async () => {
    const fetchMock = stubFetch(makePulse());
    renderWithClient(<MobileTodaySummaryBar />);
    await waitFor(() => expect(screen.getByText("주문")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "배송 현황 새로고침" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("펄스 실패 시 실패 문구를 명시한다(에러 삼킴 금지)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithClient(<MobileTodaySummaryBar />);
    await waitFor(() => {
      expect(screen.getByText("진행 현황을 불러오지 못했습니다")).toBeInTheDocument();
    });
    consoleSpy.mockRestore();
  });
});
