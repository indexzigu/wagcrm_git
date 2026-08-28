import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CalendarPageClient } from "../calendar-page-client";
import type { CalendarCampaign } from "@/components/crm/calendar-view";

// 페이지가 예비 일정 생성 후 공백 브리핑 갱신에 useRouter().refresh()를 쓴다.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// 현재 월(로컬 기준) — 컴포넌트가 new Date()로 초기 월을 잡으므로 픽스처도 같은 기준으로 생성
function currentYm(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function makeCampaign(overrides: Partial<CalendarCampaign> = {}): CalendarCampaign {
  const ym = currentYm();
  return {
    id: "camp-1",
    dealName: "프리미엄 마린콜라겐",
    sellerName: "하늘언니",
    sellerId: "seller-1",
    startDate: `${ym}-05T00:00:00.000Z`,
    endDate: `${ym}-20T00:00:00.000Z`,
    status: "ACTIVE",
    settlementSales: null,
    actualSales: null,
    sellerExpense: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    ...overrides,
  };
}

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CalendarPageClient 응답 파싱 (버그 회귀: 항상 빈 달력)", () => {
  it("API의 { campaigns } 객체 응답에서 배열을 꺼내 렌더한다", async () => {
    // route.ts는 NextResponse.json({ campaigns })로 감싸 반환 — 배열 캐스팅하면 항상 빈 달력이 됐다
    const fetchMock = stubFetch({ campaigns: [makeCampaign()] });

    render(<CalendarPageClient />);

    // 바 라벨은 이제 "딜명 · 셀러명" 조합 — 딜명이 부분 문자열로 포함된다.
    // 캠페인이 여러 주(week)에 걸치면 주마다 바가 렌더되므로 복수 매칭 허용
    expect((await screen.findAllByText(/프리미엄 마린콜라겐/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("이 달에 진행되는 캠페인이 없습니다.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/campaigns/calendar?month=${currentYm()}`);
  });

  it("campaigns가 빈 배열이면 빈 상태 문구를 보여준다", async () => {
    stubFetch({ campaigns: [] });

    render(<CalendarPageClient />);

    expect(await screen.findByText("이 달에 진행되는 캠페인이 없습니다.")).toBeInTheDocument();
  });

  it("campaigns 필드가 없는 비정상 응답이면 빈 배열로 폴백한다", async () => {
    stubFetch({});

    render(<CalendarPageClient />);

    expect(await screen.findByText("이 달에 진행되는 캠페인이 없습니다.")).toBeInTheDocument();
  });
});
