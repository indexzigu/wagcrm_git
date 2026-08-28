// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataIntegrityCard } from "../data-integrity-card";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

type Issue = DesktopDashboardData["dataIntegrityIssues"][number];

function issues(count: number): Issue[] {
  return Array.from({ length: count }, (_, i) => ({
    campaignId: `c${i}`,
    campaignName: `캠페인 ${i}`,
    type: "SETTLEMENT_INCOMPLETE",
    label: "정산완료 처리됐으나 입금·지급 미확인",
  })) as Issue[];
}

describe("DataIntegrityCard", () => {
  // 오너 2026-07-24: 영문 병행 표기 제거 + 더보기는 페이지 이동 없이 팝업
  it("제목에 영문 병행 표기가 없다", () => {
    render(<DataIntegrityCard issues={issues(3)} />);
    expect(screen.getByText("데이터 점검")).toBeInTheDocument();
    expect(screen.queryByText(/Data Hygiene/)).not.toBeInTheDocument();
  });

  it("5건 이하면 더보기가 없다", () => {
    render(<DataIntegrityCard issues={issues(5)} />);
    expect(screen.queryByText(/더보기/)).not.toBeInTheDocument();
  });

  it("더보기는 페이지 이동 없이 팝업으로 전체 목록을 연다", () => {
    render(<DataIntegrityCard issues={issues(8)} />);
    const trigger = screen.getByRole("button", { name: /3건의 무결성 이슈 더보기/ });
    // 링크(페이지 이동)가 아니라 버튼이어야 한다
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    expect(screen.getByText("데이터 점검 전체 8건")).toBeInTheDocument();
    // 카드에는 5건까지만, 팝업에는 잘렸던 6번째 이후 항목도 있어야 한다
    expect(screen.getByText("캠페인 7")).toBeInTheDocument();
  });
});
