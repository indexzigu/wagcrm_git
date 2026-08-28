// 홈 「다가올 일정」의 대금 줄 색 — 예정과 **완료**는 같은 색이 아니다 (2026-08-26).
//
// 완료된 대금이 실제 이체일로 옮겨오면서(오너 지적 2026-07-15) 이 카드에도 「지급 완료」
// 줄이 뜬다. 색 판정이 "대금인가"만 보던 동안에는 그 줄이 **주의색**으로 그려져, 이미 끝난
// 일이 아직 할 일과 같은 무게로 읽혔다(P8 §1 — 색은 의미축을 탄다: 심각도 vs 완료).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpcomingScheduleBody } from "../upcoming-schedule-card";

const event = (type: string) => ({
  date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  type,
  label: "딜A - 셀러1",
});

function toneOf(text: string): string {
  return (screen.getByText(text).getAttribute("style") ?? "").replace(/\s/g, "");
}

describe("UpcomingScheduleBody — 대금 줄의 색", () => {
  it("완료 줄의 도트도 예정(골드)과 다른 색이다 — 캘린더 완료 도트와 같은 축", () => {
    const { container } = render(<UpcomingScheduleBody events={[event("입금 완료 (공급사)")]} thisWeekLabel="이번 주" nextWeekLabel="다음 주" />);
    const dots = [...container.querySelectorAll("span[aria-hidden]")]
      .map((el) => el.getAttribute("style") ?? "")
      .filter((style) => style.includes("background-color"));
    expect(dots.some((style) => style.includes("var(--status-success)"))).toBe(true);
    expect(dots.some((style) => style.includes("var(--accent-gold)"))).toBe(false);
  });

  it("예정 줄은 주의색을 유지한다", () => {
    render(<UpcomingScheduleBody events={[event("지급 예정 (셀러)")]} thisWeekLabel="이번 주" nextWeekLabel="다음 주" />);
    expect(toneOf("지급 예정 (셀러)")).toContain("var(--status-caution-text)");
  });

  it("완료 줄은 주의색이 아니라 완료색이다", () => {
    render(<UpcomingScheduleBody events={[event("지급 완료 (셀러)")]} thisWeekLabel="이번 주" nextWeekLabel="다음 주" />);
    const style = toneOf("지급 완료 (셀러)");
    expect(style).toContain("var(--status-success)");
    expect(style).not.toContain("caution");
  });
});
