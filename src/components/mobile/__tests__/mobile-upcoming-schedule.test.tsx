// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MobileUpcomingSchedule, selectUpcomingItems } from "../mobile-upcoming-schedule";
import type { MobileCalendarItem } from "@/lib/mobile-calendar-groups";

function makeItem(overrides: Partial<MobileCalendarItem> = {}): MobileCalendarItem {
  return {
    kind: "campaign",
    key: "camp-1",
    groupId: null,
    dealName: "프리미엄 마린콜라겐",
    sellerName: "하늘언니",
    sellerId: "seller-1",
    roundNumber: null,
    startDate: "2026-07-20T00:00:00.000Z",
    endDate: "2026-07-26T00:00:00.000Z",
    status: "PREPARATION",
    // 기본 픽스처 채널은 셀러몰(=입금+지급 두 슬롯) — 자사몰 케이스는 override 로 준다.
    // 묶음 항목은 멤버 채널 전부가 들어온다(개별은 1개).
    salesChannels: ["SELLER_MALL"],
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    members: [],
    ...overrides,
  };
}

describe("selectUpcomingItems", () => {
  it("오늘(포함) 이후 시작 일정만 시작일 오름차순 최대 3건 선별한다", () => {
    const items = [
      makeItem({ key: "past", startDate: "2026-07-10T00:00:00.000Z" }),
      makeItem({ key: "today", startDate: "2026-07-15T00:00:00.000Z" }),
      makeItem({ key: "d4", startDate: "2026-07-28T00:00:00.000Z" }),
      makeItem({ key: "d2", startDate: "2026-07-21T00:00:00.000Z" }),
      makeItem({ key: "d3", startDate: "2026-07-25T00:00:00.000Z" }),
    ];

    const upcoming = selectUpcomingItems(items, "2026-07-15");
    expect(upcoming.map((item) => item.key)).toEqual(["today", "d2", "d3"]);
  });

  it("todayYmd가 비어 있으면(하이드레이션 전) 빈 배열을 반환한다", () => {
    expect(selectUpcomingItems([makeItem()], "")).toEqual([]);
  });

  it("선택일에 시작하는 일정은 제외한다 — 일별 리스트와 중복 노출 방지(ss P1)", () => {
    const items = [
      makeItem({ key: "today", startDate: "2026-07-15T00:00:00.000Z" }),
      makeItem({ key: "d2", startDate: "2026-07-21T00:00:00.000Z" }),
    ];

    // 기본 진입(선택일=오늘): 오늘 시작 건은 일별 리스트가 이미 보여주므로 제외
    expect(
      selectUpcomingItems(items, "2026-07-15", 3, "2026-07-15").map((item) => item.key),
    ).toEqual(["d2"]);

    // 다른 날짜 선택 시: 그 날짜 시작 건만 제외되고 오늘 시작 건은 복귀
    expect(
      selectUpcomingItems(items, "2026-07-15", 3, "2026-07-21").map((item) => item.key),
    ).toEqual(["today"]);
  });
});

describe("MobileUpcomingSchedule", () => {
  it("딜명·셀러·기간·상태 배지를 렌더하고 탭하면 항목 키로 상세를 연다", () => {
    const onOpenCampaign = vi.fn();
    render(
      <MobileUpcomingSchedule
        items={[
          makeItem(),
          makeItem({
            kind: "group",
            key: "group:group-1",
            groupId: "group-1",
            dealName: "마린콜라겐 그룹",
            sellerName: "하늘맘",
            startDate: "2026-07-22T00:00:00.000Z",
            endDate: "2026-07-29T00:00:00.000Z",
            status: "ACTIVE",
          }),
        ]}
        onOpenCampaign={onOpenCampaign}
      />,
    );

    expect(screen.getByText("다가오는 일정")).toBeInTheDocument();
    expect(screen.getByText("프리미엄 마린콜라겐")).toBeInTheDocument();
    expect(screen.getByText("하늘언니")).toBeInTheDocument();
    expect(screen.getByText("7.20 – 7.26")).toBeInTheDocument();
    // StatusBadge 정본 라벨(status-badge.tsx 스킴)
    expect(screen.getByText("세팅 대기")).toBeInTheDocument();
    expect(screen.getByText("판매 진행 중")).toBeInTheDocument();

    fireEvent.click(screen.getByText("마린콜라겐 그룹"));
    expect(onOpenCampaign).toHaveBeenCalledWith("group:group-1");
  });

  it("다가오는 일정이 없으면 빈 상태를 보여준다", () => {
    render(<MobileUpcomingSchedule items={[]} onOpenCampaign={vi.fn()} />);
    expect(screen.getByText("다가오는 일정이 없습니다.")).toBeInTheDocument();
  });
});
