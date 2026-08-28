// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
// 링을 색 리터럴이 아니라 의미(입금/지급)로 집는다 — 색이 바뀌어도 동작 단언은 살아야 한다.
import {
  MobileScheduleCalendar,
  MONEY_DEPOSIT,
  MONEY_PAYOUT,
} from "../mobile-schedule-calendar";
import { MobileScheduleDayList } from "../mobile-schedule-day-list";
import type { MobileCalendarCampaign } from "@/lib/mobile-calendar-data";
// 색은 리터럴이 아니라 규칙 SSOT 에서 집는다 — 값이 바뀌어도 「어느 랭크인가」 단언은 살아야 한다.
import {
  MONEY_DIRECTION_TEXT,
  MONEY_ROW_AMOUNT_NEUTRAL,
  MONEY_ROW_SETTLED_MUTED,
} from "@/lib/money-direction";

function makeCampaign(overrides: Partial<MobileCalendarCampaign> = {}): MobileCalendarCampaign {
  return {
    id: "camp-1",
    dealName: "프리미엄 마린콜라겐",
    sellerName: "하늘언니",
    sellerId: "seller-1",
    groupId: null,
    groupName: null,
    roundNumber: 2,
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-10T00:00:00.000Z",
    status: "ACTIVE",
    // 기본 픽스처 채널은 셀러몰(=입금+지급 두 슬롯) — 자사몰 케이스는 override 로 준다.
    salesChannel: "SELLER_MALL",
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    settlementSales: null,
    actualSales: null,
    sellerExpense: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...overrides,
  };
}

describe("MobileScheduleCalendar", () => {
  it("renders the month grid with span bars — no urgency tint, no color legend (오너 피드백 2026-07-14)", () => {
    const campaigns = [
      makeCampaign(),
      makeCampaign({
        id: "camp-2",
        dealName: "비타민C 앰플",
        sellerName: "하늘맘",
        startDate: "2026-06-20T00:00:00.000Z",
        endDate: "2026-06-25T00:00:00.000Z",
        expectedDepositDate: "2026-07-16T00:00:00.000Z",
        settlementSales: 12400000,
      }),
    ];

    const { container } = render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={campaigns}
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );

    expect(screen.getByText("2026년 7월")).toBeInTheDocument();
    expect(screen.getByLabelText("이전 달")).toBeInTheDocument();

    const selected = screen.getByLabelText("7월 8일 선택");
    expect(selected).toHaveAttribute("aria-pressed", "true");

    // camp-1(7/1~7/10)이 두 주에 걸치므로 주 세그먼트 2개 이상
    const bars = container.querySelectorAll('[style*="grid-column"]');
    expect(bars.length).toBeGreaterThanOrEqual(2);

    // 오너 피드백(2026-07-15) ①: 스팬 바는 행(48px) 안에서 날짜 숫자와 세로
    // 중앙 정렬(top 8px + 32px), 배경은 캘린더 토큰 계열(연회색 gradient 폐기).
    const barLayer = bars[0].parentElement as HTMLElement;
    expect(barLayer.className).toContain("top-[8px]");
    expect(bars[0].className).toContain("h-[32px]");
    expect(bars[0].className).toContain("--cal-primary-soft");
    expect(bars[0].className).not.toContain("from-slate-50");
    // 오너 선택안 B(2026-07-15): 바닥 알파 16%→8%로 낮춤(너무 진함 해소).
    expect(bars[0].className).toContain("--cal-primary)/0.08");
    expect(bars[0].className).not.toContain("/0.16");

    // 오너 피드백(2026-07-15) ②: 캘린더 카드 모서리는 다른 카드와 동일한
    // rounded-2xl — rounded-[2.5rem] 단독 이탈 금지.
    const section = container.querySelector("section") as HTMLElement;
    expect(section.className).toContain("rounded-2xl");
    expect(section.className).not.toContain("rounded-[2.5rem]");

    // 캠페인 없는 주의 위험 틴트(빨간박스) 제거 — 확보구간은 얇은바(MobileScheduleGapBars) 전담
    expect(container.querySelectorAll('[class*="--cal-danger-bg"]').length).toBe(0);
    expect(container.querySelectorAll('[class*="--cal-urgent-bg"]').length).toBe(0);

    // 입금·출금·일정 색상 범례 제거
    expect(screen.queryByText("입금")).not.toBeInTheDocument();
    expect(screen.queryByText("출금")).not.toBeInTheDocument();
    expect(screen.queryByText("일정")).not.toBeInTheDocument();
  });

  it("같은 주에 겹치는 캠페인은 하나의 스팬 바로 병합한다(2겹 겹침 버그 회귀)", () => {
    const campaigns = [
      makeCampaign({
        id: "camp-1",
        startDate: "2026-07-06T00:00:00.000Z",
        endDate: "2026-07-08T00:00:00.000Z",
      }),
      makeCampaign({
        id: "camp-2",
        dealName: "비타민C 앰플",
        startDate: "2026-07-07T00:00:00.000Z",
        endDate: "2026-07-10T00:00:00.000Z",
      }),
    ];

    const { container } = render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={campaigns}
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('[style*="grid-column"]').length).toBe(1);
  });

  it("같은 주라도 날짜가 떨어진 캠페인은 별도 스팬 바로 남긴다", () => {
    const campaigns = [
      makeCampaign({
        id: "camp-1",
        startDate: "2026-07-06T00:00:00.000Z",
        endDate: "2026-07-07T00:00:00.000Z",
      }),
      makeCampaign({
        id: "camp-2",
        dealName: "비타민C 앰플",
        startDate: "2026-07-09T00:00:00.000Z",
        endDate: "2026-07-10T00:00:00.000Z",
      }),
    ];

    const { container } = render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={campaigns}
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('[style*="grid-column"]').length).toBe(2);
  });

  it("groups same CampaignGroup members into one mobile span bar", () => {
    const campaigns = [
      makeCampaign({
        id: "camp-1",
        dealName: "마린콜라겐 A",
        groupId: "group-1",
        groupName: "마린콜라겐 그룹",
        startDate: "2026-07-06T00:00:00.000Z",
        endDate: "2026-07-08T00:00:00.000Z",
      }),
      makeCampaign({
        id: "camp-2",
        dealName: "마린콜라겐 B",
        groupId: "group-1",
        groupName: "마린콜라겐 그룹",
        startDate: "2026-07-07T00:00:00.000Z",
        endDate: "2026-07-08T00:00:00.000Z",
      }),
    ];

    const { container } = render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={campaigns}
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('[style*="grid-column"]').length).toBe(1);
  });
});

describe("입금·출금 링 — 배지 + 예정(점선)/완료(실선) (오너 피드백 2026-07-15)", () => {
  // 링은 선택된 날에는 숨으므로 자금일과 선택일을 분리한다.
  function renderWith(overrides: Partial<MobileCalendarCampaign>) {
    return render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={[makeCampaign({ id: "m1", startDate: "2026-07-09T00:00:00.000Z", endDate: "2026-07-09T00:00:00.000Z", ...overrides })]}
        selectedYmd="2026-07-01"
        todayYmd="2026-07-01"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );
  }

  it("입금 예정(미수령)은 초록 점선 링, 배지 없음", () => {
    const { container } = renderWith({ expectedDepositDate: "2026-07-09T00:00:00.000Z", isDepositReceived: false });
    const circle = container.querySelector(`circle[stroke="${MONEY_DEPOSIT}"]`) as SVGCircleElement;
    expect(circle).toBeTruthy();
    expect(circle.getAttribute("stroke-dasharray")).toBe("3 2.6"); // 예정=점선
    expect(container.querySelector(`circle[stroke="${MONEY_PAYOUT}"]`)).toBeNull();
    // 배지(고유 클래스 font-extrabold)로 스코프 — 날짜 숫자 "2"와 충돌 방지
    expect(container.querySelector('[class*="font-extrabold"]')).toBeNull();
  });

  it("입금 완료(수령)는 초록 실선 링(점선 아님)", () => {
    const { container } = renderWith({ expectedDepositDate: "2026-07-09T00:00:00.000Z", isDepositReceived: true });
    const circle = container.querySelector(`circle[stroke="${MONEY_DEPOSIT}"]`) as SVGCircleElement;
    expect(circle).toBeTruthy();
    expect(circle.getAttribute("stroke-dasharray")).toBeNull(); // 완료=실선
  });

  /**
   * 오너 지적 2026-07-15 — 완료된 칸은 **실제로 오간 날**에 선다. 링이 예정일에 남으면
   * 데스크톱 도트·구글 캘린더와 같은 캠페인이 서로 다른 날에 뜬다.
   */
  it("완료된 입금은 예정일이 아니라 실제 입금일에 링이 선다", () => {
    render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={[
          makeCampaign({
            id: "moved",
            startDate: "2026-07-09T00:00:00.000Z",
            endDate: "2026-07-09T00:00:00.000Z",
            expectedDepositDate: "2026-07-16T00:00:00.000Z",
            depositReceivedAt: "2026-07-09T00:00:00.000Z",
            isDepositReceived: true,
          }),
        ]}
        selectedYmd="2026-07-01"
        todayYmd="2026-07-01"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );

    // 셀 aria-label 에는 자금 요약이 덧붙으므로 접두사로 집는다("7월 9일 선택, 입금 완료").
    const cellOf = (day: number) =>
      screen
        .getByLabelText(new RegExp(`^7월 ${day}일 선택`))
        .querySelector(`circle[stroke="${MONEY_DEPOSIT}"]`);
    expect(cellOf(9)).toBeTruthy();
    expect(cellOf(16)).toBeNull();
  });

  it("같은 날 입금 2건이면 건수 배지(2)를 표시한다", () => {
    const { container } = render(
      <MobileScheduleCalendar
        year={2026}
        monthIndex={6}
        campaigns={[
          makeCampaign({ id: "a", expectedDepositDate: "2026-07-09T00:00:00.000Z", isDepositReceived: false }),
          makeCampaign({ id: "b", expectedDepositDate: "2026-07-09T00:00:00.000Z", isDepositReceived: false }),
        ]}
        selectedYmd="2026-07-01"
        todayYmd="2026-07-01"
        onSelectDate={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );
    const badge = container.querySelector('[class*="font-extrabold"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("2");
    expect(container.querySelector(`circle[stroke="${MONEY_DEPOSIT}"]`)).toBeTruthy();
  });

  it("입금·출금이 같은 날이면 상(입금)·하(지급) 반원 두 개를 그린다", () => {
    const { container } = renderWith({
      expectedDepositDate: "2026-07-09T00:00:00.000Z",
      isDepositReceived: false,
      expectedPayoutDate: "2026-07-09T00:00:00.000Z",
      isPayoutCompleted: false,
    });
    const paths = container.querySelectorAll("path[stroke]");
    const strokes = Array.from(paths).map((p) => p.getAttribute("stroke"));
    expect(strokes).toContain(MONEY_DEPOSIT); // 입금 반원
    expect(strokes).toContain(MONEY_PAYOUT); // 지급 반원
  });

  it("aria-label에 입금/지급 예정·완료 상태를 텍스트로 노출한다(WCAG 1.4.1)", () => {
    renderWith({ expectedDepositDate: "2026-07-09T00:00:00.000Z", isDepositReceived: true });
    expect(screen.getByLabelText(/7월 9일 선택, 입금 완료/)).toBeInTheDocument();
  });
});

describe("MobileScheduleDayList", () => {
  it("lists the selected day's campaigns and pending money events with bold amounts", () => {
    const campaigns = [
      makeCampaign(),
      makeCampaign({
        id: "camp-3",
        dealName: "선식 세트",
        sellerName: "지유",
        roundNumber: null,
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-10T00:00:00.000Z",
        expectedPayoutDate: "2026-07-08T00:00:00.000Z",
        actualPayoutAmount: 3850000,
      }),
    ];

    const onOpenCampaign = vi.fn();

    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        campaigns={campaigns}
        onOpenCampaign={onOpenCampaign}
      />,
    );

    expect(screen.getByText("7월 8일 (수)")).toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(screen.getByText("프리미엄 마린콜라겐")).toBeInTheDocument();
    expect(screen.getByText("2차")).toBeInTheDocument();
    expect(screen.getByText("진행중")).toBeInTheDocument();
    // 배지는 상대를 병기한다 — 자사몰의 두 지급을 가르는 유일한 표기라 전 채널 공통
    // 규칙으로 둔다(오너 확정 2026-08-25). 픽스처는 셀러몰이라 지급 상대가 공급사다.
    expect(screen.getByText("지급 예정 (공급사)")).toBeInTheDocument();
    // ⚠️ **공급사 지급은 「금액 미정」이 정답이다**(오너 확정 2026-08-26). 그 칸의 금액은
    // 물품대금인데, 그 값은 「캠페인의 원가」가 아니라 **그 캠페인 앞으로 온 매입 계산서
    // 총액**이라 여러 캠페인·여러 셀러가 한 장에 묶인다 — 캠페인 단위 칸에 끌어오면 남의
    // 금액이 뜬다(`expected-receivables-scope.contract.test.ts` 가 그 경계를 지킨다).
    // 종전에는 이 자리에 **셀러 실지급액**이 찍혀 상대(공급사)와 금액(셀러 몫)이 어긋나
    // 있었다. 0 으로 접지도 않는다 — 금전 대조에서 ₩0 은 확인된 0으로 읽힌다.
    expect(screen.getByText("금액 미정")).toBeInTheDocument();
    expect(screen.queryByText(/^입금 예정/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("프리미엄 마린콜라겐"));
    fireEvent.click(screen.getByText("지급 예정 (공급사)"));
    expect(onOpenCampaign).toHaveBeenNthCalledWith(1, "camp-1");
    expect(onOpenCampaign).toHaveBeenNthCalledWith(2, "camp-3");
  });

  /**
   * 종전에는 완료된 대금 줄을 **숨겼다** — 그러면 "실제일로 이동"이 이 화면에서만 보이지
   * 않아, 링·도트는 15일을 가리키는데 그 날 목록에는 아무 것도 없는 상태가 된다
   * (오너 확정 2026-08-26: 실제일에 완료 줄로 표시).
   */
  it("완료된 대금은 실제일에 완료 줄로 뜬다 (예정일에는 없다)", () => {
    const campaigns = [
      makeCampaign({
        id: "paid",
        dealName: "선식 세트",
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-10T00:00:00.000Z",
        expectedPayoutDate: "2026-07-20T00:00:00.000Z",
        payoutCompletedAt: "2026-07-15T00:00:00.000Z",
        isPayoutCompleted: true,
      }),
    ];

    const { unmount } = render(
      <MobileScheduleDayList
        selectedYmd="2026-07-15"
        todayYmd="2026-07-15"
        campaigns={campaigns}
        onOpenCampaign={vi.fn()}
      />,
    );
    expect(screen.getByText("지급 완료 (공급사)")).toBeInTheDocument();
    unmount();

    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-20"
        todayYmd="2026-07-15"
        campaigns={campaigns}
        onOpenCampaign={vi.fn()}
      />,
    );
    expect(screen.queryByText(/지급/)).not.toBeInTheDocument();
  });

  /**
   * 같은 날짜에 **아직 할 일**과 **이미 끝난 일**이 함께 서는 날의 스캔성 — 완료 줄을
   * 노출하기로 한 오너 확정(2026-08-26)의 대가로 생긴 문제다. 픽스처는 완료 건을
   * 배열 앞에 두어 **정렬이 없으면 완료가 먼저 뜨도록** 만든다(정렬을 실제로 검증).
   */
  function makeMixedMoneyDay(): MobileCalendarCampaign[] {
    return [
      makeCampaign({
        id: "settled",
        // ⚠️ 딜명이 정렬 키다(`buildMobileCalendarItems` = startDate → dealName ko).
        // 완료 건이 **자연 순서상 먼저** 오게 이름을 골라야 이 테스트가 정렬을 실제로
        // 검증한다 — 반대로 두면 정렬을 지워도 초록이 나온다(실제로 그렇게 한 번 샜다).
        dealName: "비타민C 앰플",
        sellerName: "하늘맘",
        roundNumber: null,
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-10T00:00:00.000Z",
        expectedPayoutDate: "2026-07-20T00:00:00.000Z",
        payoutCompletedAt: "2026-07-15T00:00:00.000Z",
        isPayoutCompleted: true,
      }),
      makeCampaign({
        id: "pending",
        dealName: "선식 세트",
        sellerName: "지유",
        roundNumber: null,
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-10T00:00:00.000Z",
        expectedPayoutDate: "2026-07-15T00:00:00.000Z",
      }),
    ];
  }

  it("아직 남은 대금이 완료된 대금보다 먼저 온다", () => {
    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-15"
        todayYmd="2026-07-15"
        campaigns={makeMixedMoneyDay()}
        onOpenCampaign={vi.fn()}
      />,
    );

    // getAllByText 는 문서 순서로 돌려준다 — 픽스처 배열은 완료가 먼저다.
    const badges = screen.getAllByText(/^지급 (예정|완료) \(공급사\)$/);
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "지급 예정 (공급사)",
      "지급 완료 (공급사)",
    ]);
  });

  it("완료 배지는 status-success, 예정 배지는 중립 회색을 쓴다", () => {
    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-15"
        todayYmd="2026-07-15"
        campaigns={makeMixedMoneyDay()}
        onOpenCampaign={vi.fn()}
      />,
    );

    // 데스크톱 캘린더 도트·정산 칸·StatusBadge 의 COMPLETED 와 같은 어휘(#483).
    expect(screen.getByText("지급 완료 (공급사)")).toHaveAttribute("data-variant", "status-success");
    // 예정은 중립 — 색은 왼쪽 방향 아이콘이 이미 쓰고 있다(한 줄에 유채색 캐리어 1개).
    expect(screen.getByText("지급 예정 (공급사)")).toHaveAttribute("data-variant", "secondary");
  });

  it("완료 줄은 방향색·금액 강조를 한 단계 낮춘 무채색으로 내린다", () => {
    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-15"
        todayYmd="2026-07-15"
        campaigns={makeMixedMoneyDay()}
        onOpenCampaign={vi.fn()}
      />,
    );

    const rowOf = (badgeText: string) =>
      screen.getByText(badgeText).closest("button") as HTMLElement;
    const settled = rowOf("지급 완료 (공급사)");
    const pending = rowOf("지급 예정 (공급사)");

    // 방향 아이콘: **모양은 양쪽 다 유지**(입금/지급 정보 손실 없음), 색만 갈린다.
    // 색은 「아직 오갈 돈」에만 남긴다 — 다 칠하면 아무것도 안 튄다(P8 §2).
    const iconClass = (row: HTMLElement) => row.querySelector("svg")?.getAttribute("class") ?? "";
    expect(iconClass(pending)).toContain(MONEY_DIRECTION_TEXT.out);
    expect(iconClass(settled)).toContain(MONEY_ROW_SETTLED_MUTED);
    expect(iconClass(settled)).not.toContain(MONEY_DIRECTION_TEXT.out);

    // 금액: 예정은 slate-800, 완료는 한 단계 낮은 무채 랭크.
    const amountClass = (row: HTMLElement) =>
      row.querySelector(".tabular-nums")?.getAttribute("class") ?? "";
    expect(amountClass(pending)).toContain(MONEY_ROW_AMOUNT_NEUTRAL);
    expect(amountClass(settled)).toContain(MONEY_ROW_SETTLED_MUTED);
    expect(amountClass(settled)).not.toContain(MONEY_ROW_AMOUNT_NEUTRAL);
  });

  it("shows an empty state when nothing is scheduled for the day", () => {
    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-20"
        todayYmd="2026-07-08"
        campaigns={[makeCampaign()]}
        onOpenCampaign={vi.fn()}
      />,
    );
    expect(screen.getByText("이 날짜에 예정된 일정이 없습니다.")).toBeInTheDocument();
  });

  it("renders group members as a single grouped item", () => {
    const campaigns = [
      makeCampaign({
        id: "camp-1",
        dealName: "마린콜라겐 A",
        groupId: "group-1",
        groupName: "마린콜라겐 그룹",
      }),
      makeCampaign({
        id: "camp-2",
        dealName: "마린콜라겐 B",
        groupId: "group-1",
        groupName: "마린콜라겐 그룹",
        startDate: "2026-07-03T00:00:00.000Z",
      }),
    ];
    const onOpenCampaign = vi.fn();

    render(
      <MobileScheduleDayList
        selectedYmd="2026-07-08"
        todayYmd="2026-07-08"
        campaigns={campaigns}
        onOpenCampaign={onOpenCampaign}
      />,
    );

    expect(screen.getByText("마린콜라겐 그룹")).toBeInTheDocument();

    fireEvent.click(screen.getByText("마린콜라겐 그룹"));
    expect(onOpenCampaign).toHaveBeenCalledWith("group:group-1");
  });
});
