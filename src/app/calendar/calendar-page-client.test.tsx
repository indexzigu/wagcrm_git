import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calendarViewMock = vi.fn();

// 페이지가 예비 일정 생성 후 공백 브리핑 갱신에 useRouter().refresh()를 쓴다.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/crm/calendar-view", () => ({
  CalendarView: (props: { campaigns: unknown }) => {
    calendarViewMock(props);
    return <div data-testid="calendar-view-stub" />;
  },
}));

import { CalendarPageClient } from "./calendar-page-client";

describe("CalendarPageClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    calendarViewMock.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the API campaigns envelope to the calendar view", async () => {
    const campaigns = [
      {
        id: "campaign-1",
        dealName: "콜라겐",
        sellerName: "셀러",
        sellerId: "seller-1",
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: "2026-07-07T00:00:00.000Z",
        status: "ACTIVE",
        // 대금 금액은 응답 스키마에서 **필수**다(값을 모르면 null 을 명시한다) —
        // 빠뜨리면 파서가 캠페인을 통째로 걷어내 화면이 빈다. 그 침묵을 막으려고
        // 일부러 `.optional()` 을 빼 뒀다(`calendar-page-client.tsx` 스키마 주석).
        settlementSales: null,
        actualPayoutAmount: null,
        settlementGoodsCost: null,
        actualSales: null,
        sellerExpense: null,
      },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ campaigns }),
    });

    render(<CalendarPageClient />);

    await waitFor(() => {
      expect(calendarViewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ campaigns }),
      );
    });
  });

  /**
   * 완료된 대금 칸은 **실제로 오간 날**에 선다(`resolveMoneySlotEffectiveDate`). 그 날짜가
   * 스키마에 없으면 `.parse()` 가 말없이 걷어내고 화면은 완료 건을 예정일에 그대로 그린다
   * — 고치기 전 동작으로 조용히 되돌아가는 형태라 크래시로 드러나지 않는다.
   */
  it("실제 완료일 3종이 파서를 통과해 캘린더로 넘어간다", async () => {
    const campaign = {
      id: "campaign-2",
      dealName: "콜라겐",
      sellerName: "셀러",
      sellerId: "seller-1",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-07T00:00:00.000Z",
      status: "ACTIVE",
      settlementSales: null,
      actualPayoutAmount: null,
      settlementGoodsCost: null,
      actualSales: null,
      sellerExpense: null,
      expectedPayoutDate: "2026-07-20T00:00:00.000Z",
      depositReceivedAt: "2026-07-08T00:00:00.000Z",
      payoutCompletedAt: "2026-07-15T00:00:00.000Z",
      supplierPayoutCompletedAt: "2026-07-11T00:00:00.000Z",
      isPayoutCompleted: true,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ campaigns: [campaign] }),
    });

    render(<CalendarPageClient />);

    await waitFor(() => {
      expect(calendarViewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ campaigns: [campaign] }),
      );
    });
  });
});
