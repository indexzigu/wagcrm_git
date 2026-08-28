import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileHomeRiskCard } from "../mobile-home-risk-card";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

type Issue = DesktopDashboardData["dataIntegrityIssues"][number];
type Exceptions = DesktopDashboardData["exceptions"];

function makeExceptions(overrides: Partial<Exceptions> = {}): Exceptions {
  return {
    overdueReminders: 0,
    pendingApprovals: 0,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    campaignId: "camp-1",
    campaignName: "비타민C 앰플 - 하늘맘",
    type: "MISSING_SALES",
    label: "종료됐으나 실매출 미입력",
    ...overrides,
  };
}

describe("MobileHomeRiskCard (홈 재구성 안 C — 오너 승인 2026-07-15)", () => {
  it("이슈 0건이면 아무것도 렌더하지 않는다(P2 Decision-Value)", () => {
    const { container } = render(
      <MobileHomeRiskCard issues={[]} exceptions={makeExceptions()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("무결성 이슈 1건 이상이면 유형 라벨·건수·상위 항목을 렌더한다", () => {
    render(
      <MobileHomeRiskCard
        issues={[
          makeIssue({ type: "NEGATIVE_SALES", label: "매출이 음수로 입력됨" }),
          makeIssue({ campaignId: "camp-2", campaignName: "콜라겐 젤리 - 봄날셀러" }),
        ]}
        exceptions={makeExceptions()}
      />,
    );
    expect(screen.getByText("리스크 신호")).toBeInTheDocument();
    expect(screen.getByText("2건")).toBeInTheDocument();
    // 유형별 칩
    expect(screen.getByText("매출 음수 1")).toBeInTheDocument();
    expect(screen.getByText("실매출 미입력 1")).toBeInTheDocument();
    // 상위 항목(캠페인명 + 문제 설명)
    expect(screen.getByText("비타민C 앰플 - 하늘맘")).toBeInTheDocument();
    expect(screen.getByText("매출이 음수로 입력됨")).toBeInTheDocument();
    expect(screen.getByText("콜라겐 젤리 - 봄날셀러")).toBeInTheDocument();
  });

  it("영업 예외(리마인더 지연·승인 대기)만 있어도 렌더한다", () => {
    render(
      <MobileHomeRiskCard
        issues={[]}
        exceptions={makeExceptions({ overdueReminders: 3, pendingApprovals: 1 })}
      />,
    );
    expect(screen.getByText("리스크 신호")).toBeInTheDocument();
    expect(screen.getByText("4건")).toBeInTheDocument();
    expect(screen.getByText("리마인더 지연 3")).toBeInTheDocument();
    expect(screen.getByText("승인 대기 1")).toBeInTheDocument();
  });

  it("상위 3건 초과분은 목록에 나열하지 않고 더보기 문구로 접는다", () => {
    const issues = [1, 2, 3, 4, 5].map((n) =>
      makeIssue({ campaignId: `camp-${n}`, campaignName: `캠페인 ${n}` }),
    );
    render(<MobileHomeRiskCard issues={issues} exceptions={makeExceptions()} />);
    expect(screen.getByText("캠페인 1")).toBeInTheDocument();
    expect(screen.getByText("캠페인 3")).toBeInTheDocument();
    expect(screen.queryByText("캠페인 4")).not.toBeInTheDocument();
    expect(screen.getByText(/\+ 2건 더/)).toBeInTheDocument();
  });
});
