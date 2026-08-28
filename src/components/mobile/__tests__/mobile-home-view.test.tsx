import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileHomeView } from "../mobile-home-view";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

// 하위 카드는 자체 테스트가 소유 — 여기서는 홈 뷰의 구성(카드 존재·순서)만 검증한다.
vi.mock("../mobile-home-pulse-card", () => ({
  MobileHomePulseCard: () => <div data-testid="pulse-card" />,
}));
vi.mock("../mobile-home-settlement-card", () => ({
  MobileHomeSettlementCard: () => <div data-testid="settlement-card" />,
}));

vi.mock("@/components/ui/animated-number", () => ({
  AnimatedNumber: ({ value }: { value: number }) => <span>{value}</span>,
}));

function makeData(overrides: Partial<DesktopDashboardData> = {}): DesktopDashboardData {
  return {
    selectedMonth: "2026-07",
    goals: {
      monthTarget: 100_000_000,
      annualTarget: 1_000_000_000,
      monthActual: 42_000_000,
      ytdActual: 480_000_000,
      prevMonthTarget: null,
      prevMonthActual: 0,
      prevPrevMonthTarget: null,
      prevPrevMonthActual: 0,
    },
    exceptions: { overdueReminders: 0, pendingApprovals: 0 },
    dataIntegrityIssues: [],
    ...overrides,
  } as unknown as DesktopDashboardData;
}

describe("MobileHomeView (홈 재구성 안 C — 오너 승인 2026-07-15)", () => {
  it("최근 90일 영업 전환 퍼널 카드를 렌더하지 않는다(안 C 제거)", () => {
    render(<MobileHomeView initialData={makeData()} />);
    expect(screen.queryByText("최근 90일 영업 전환")).not.toBeInTheDocument();
    expect(screen.queryByText("접촉")).not.toBeInTheDocument();
    expect(screen.queryByText(/응답률/)).not.toBeInTheDocument();
  });

  it("카드 순서: 상단바 → 매출 목표 히어로 → 오늘의 펄스 → 정산 대기", () => {
    render(<MobileHomeView initialData={makeData()} />);
    const hero = screen.getByText("연간 누적");
    const pulse = screen.getByTestId("pulse-card");
    const settlement = screen.getByTestId("settlement-card");

    // 상단바 제목 존재
    expect(screen.getByText("홈 대시보드")).toBeInTheDocument();
    // 히어로 → 펄스 → 정산 대기 순서(DOM 문서 순)
    expect(hero.compareDocumentPosition(pulse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pulse.compareDocumentPosition(settlement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("리스크 신호 카드는 이슈 0건이면 미렌더, 1건 이상이면 정산 대기 뒤에 렌더", () => {
    const { rerender } = render(<MobileHomeView initialData={makeData()} />);
    expect(screen.queryByText("리스크 신호")).not.toBeInTheDocument();

    rerender(
      <MobileHomeView
        initialData={makeData({
          dataIntegrityIssues: [
            {
              campaignId: "camp-1",
              campaignName: "비타민C 앰플 - 하늘맘",
              type: "MISSING_SALES",
              label: "종료됐으나 실매출 미입력",
            },
          ],
        })}
      />,
    );
    const risk = screen.getByText("리스크 신호");
    expect(risk).toBeInTheDocument();
    const settlement = screen.getByTestId("settlement-card");
    expect(settlement.compareDocumentPosition(risk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
