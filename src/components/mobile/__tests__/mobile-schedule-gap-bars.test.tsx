import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileScheduleGapBars } from "../mobile-schedule-gap-bars";
import type { ScheduleGap } from "@/lib/schedule-gap-briefing";

function gap(overrides: Partial<ScheduleGap>): ScheduleGap {
  return {
    label: "7/18~7/20",
    startDate: "2026-07-18T00:00:00.000Z",
    endDate: "2026-07-20T00:00:00.000Z",
    daysFromNow: 9,
    dayCount: 3,
    urgency: "DANGER",
    actionLabel: "즉시 일정 확보 필요",
    ...overrides,
  };
}

describe("MobileScheduleGapBars (item 10 — 일 단위 빈 구간)", () => {
  it("접힘 상태는 한 줄 요약만 — 경고 메시지(actionLabel)는 숨김", () => {
    render(
      <MobileScheduleGapBars
        gaps={[
          gap({}),
          gap({
            label: "7/27~7/31",
            startDate: "2026-07-27T00:00:00.000Z",
            urgency: "URGENT",
            actionLabel: "이번 주 내 일정 확정",
          }),
        ]}
        onSelectGap={vi.fn()}
      />,
    );
    expect(screen.getByText(/확보 필요/)).toBeInTheDocument();
    expect(screen.getByText("2구간")).toBeInTheDocument();
    expect(screen.getByText(/7\/18~7\/20/)).toBeInTheDocument();
    // 경고 메시지는 접힘 상태에서 미표시
    expect(screen.queryByText("즉시 일정 확보 필요")).not.toBeInTheDocument();
  });

  it("펼치면 구간별 기간·경고 메시지가 나오고, 행 탭이 onSelectGap을 호출한다", async () => {
    const onSelect = vi.fn();
    const danger = gap({});
    render(<MobileScheduleGapBars gaps={[danger]} onSelectGap={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: /확보 필요 1구간/ }));
    expect(screen.getByText("즉시 일정 확보 필요")).toBeInTheDocument();
    expect(screen.getByText(/3일/)).toBeInTheDocument();

    await userEvent.click(screen.getByText("즉시 일정 확보 필요"));
    expect(onSelect).toHaveBeenCalledWith(danger);
    // 행 탭 후 자동 접힘
    expect(screen.queryByText("즉시 일정 확보 필요")).not.toBeInTheDocument();
  });

  it("2구간 초과는 '외 N건'으로 축약한다", () => {
    render(
      <MobileScheduleGapBars
        gaps={[
          gap({ label: "7/18~7/20" }),
          gap({ label: "7/27~7/31", startDate: "2026-07-27T00:00:00.000Z" }),
          gap({ label: "8/5", startDate: "2026-08-05T00:00:00.000Z" }),
        ]}
        onSelectGap={vi.fn()}
      />,
    );
    expect(screen.getByText(/외 1건/)).toBeInTheDocument();
  });

  it("위험 구간이 없으면 아무것도 렌더하지 않는다", () => {
    const { container } = render(
      <MobileScheduleGapBars
        gaps={[gap({ urgency: "CAUTION", actionLabel: "셀러 제안 및 협의 가속" })]}
        onSelectGap={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
