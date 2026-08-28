// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ActionBadge } from "../action-badge";

describe("ActionBadge Component", () => {
  const refDate = new Date("2026-06-30T12:00:00");

  it("팔로업 제안이 없으면 아무것도 렌더링하지 않는다", () => {
    const task = {
      status: "PROPOSED",
      proposalSentAt: "2026-06-25T00:00:00", // 5일 지남 (14일 미만)
    };
    const { container } = render(
      <ActionBadge task={task} referenceDate={refDate} />
    );
    expect(container.firstChild).toBeNull();
  });

  // 리마인드 종류별 색 구분 없이 단일 status-info 톤 (소유자 승인 2026-07-09, 모바일 40dfd56 정합).
  // 종류 구분은 라벨/아이콘이 담당하고, 색은 서비스 팔레트 status-info로 통일한다.
  it("1차 리마인드 권장 조건일 때 올바른 텍스트와 단일 info 톤으로 렌더링한다", () => {
    const task = {
      status: "PROPOSED",
      proposalSentAt: "2026-06-15T00:00:00", // 15일 지남
    };
    render(<ActionBadge task={task} referenceDate={refDate} />);

    const badge = screen.getByText("1차 리마인드 권장");
    expect(badge).toBeInTheDocument();

    const container = badge.parentElement;
    expect(container).toHaveClass("bg-status-info/10");
    expect(container).toHaveClass("text-status-info");
  });

  it("지정일 리마인드 조건일 때 올바른 텍스트와 단일 info 톤으로 렌더링한다", () => {
    const task = {
      status: "PROPOSED",
      proposalSentAt: "2026-06-29T00:00:00",
      nextReminderAt: "2026-06-30T00:00:00", // 오늘 예정
    };
    render(<ActionBadge task={task} referenceDate={refDate} />);

    const badge = screen.getByText("지정일 팔로업 필요");
    expect(badge).toBeInTheDocument();

    const container = badge.parentElement;
    expect(container).toHaveClass("bg-status-info/10");
    expect(container).toHaveClass("text-status-info");
  });

  it("클릭 시 onClick 콜백이 호출된다", () => {
    const task = {
      status: "PROPOSED",
      proposalSentAt: "2026-06-15T00:00:00",
    };
    const handleClick = vi.fn();
    render(
      <ActionBadge task={task} referenceDate={refDate} onClick={handleClick} />
    );
    
    const badge = screen.getByText("1차 리마인드 권장");
    fireEvent.click(badge);
    
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
