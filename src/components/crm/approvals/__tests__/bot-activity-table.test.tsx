// @vitest-environment jsdom
/**
 * BotActivityTable — 결재함 「봇 활동」 표 (Plan 2 Task 4).
 *
 * 봇 작업 큐(AgentJob)의 최근 행을 5열 표로 보여준다. 상태 문자열 9종은 운영자가
 * 읽는 라벨 7종으로 접히고(같은 판단을 낳는 상태는 같은 라벨), 모르는 상태는
 * 원문을 그대로 보여 조용히 사라지지 않게 한다.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// 실제 next/link 는 className 등 나머지 props 를 <a> 로 흘린다 — 그것까지 흉내 내야
// 포커스 링 같은 클래스 계약을 이 스텁 위에서 검증할 수 있다.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { BotActivityTable } from "../bot-activity-table";
import type { AgentJobListItem } from "@/lib/agent-jobs/list-item";

function makeJob(overrides: Partial<AgentJobListItem> = {}): AgentJobListItem {
  return {
    id: "job-1",
    status: "SUCCEEDED",
    operation: "search_deals",
    taskType: "READ",
    createdAt: "2026-09-22T05:30:00Z",
    updatedAt: "2026-09-22T05:30:10Z",
    attempt: 1,
    failureCode: null,
    resultStatus: "OK",
    resultSummary: "딜 3건을 찾았습니다.",
    actionProposalId: null,
    payloadUnreadable: false,
    ...overrides,
  };
}

describe("BotActivityTable", () => {
  it("헤더는 th[scope=col] 5개다 (시각·작업·상태·요약·결과)", () => {
    render(<BotActivityTable items={[makeJob()]} includeSucceeded onToggleSucceeded={vi.fn()} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(5);
    expect(headers.map((h) => h.getAttribute("scope"))).toEqual(Array(5).fill("col"));
    expect(headers.map((h) => h.textContent)).toEqual(["시각", "작업", "상태", "요약", "결과"]);
  });

  it.each([
    ["SUCCEEDED", "완료"],
    ["QUEUED", "진행 중"],
    ["CLAIMED", "진행 중"],
    ["RUNNING", "진행 중"],
    ["NEEDS_EXTERNAL_EXECUTOR", "보류"],
    ["RESOURCE_DEFERRED", "보류"],
    ["NEEDS_APPROVAL", "승인 대기"],
    ["FAILED_RETRYABLE", "재시도 중"],
    ["FAILED_FINAL", "실패"],
    ["FAILED_SECURITY", "차단됨"],
  ])("상태 %s 는 %s 로 보여준다", (status, label) => {
    render(
      <BotActivityTable
        items={[makeJob({ status })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText(label)).toBeInTheDocument();
  });

  it("모르는 상태는 원문을 그대로 보여준다", () => {
    render(
      <BotActivityTable
        items={[makeJob({ status: "SOMETHING_NEW" })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.getByText("SOMETHING_NEW")).toBeInTheDocument();
  });

  it("actionProposalId 가 있으면 결과 링크를, 없으면 하이픈을 보여준다", () => {
    const { rerender } = render(
      <BotActivityTable
        items={[makeJob({ actionProposalId: "proposal-9" })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.getByRole("link", { name: "딜 검색 결과 보기" })).toHaveAttribute(
      "href",
      "/approvals/proposal-9"
    );

    rerender(
      <BotActivityTable
        items={[makeJob({ actionProposalId: null })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  // 「결과」 여섯 줄이 같은 이름으로 늘어서면 링크 목록만으로는 어느 작업의 결과인지
  // 알 수 없다 — 접근 이름에 작업 이름을 넣는다(WCAG 2.4.4).
  it("결과 링크의 접근 이름은 어느 작업의 결과인지 말한다", () => {
    render(
      <BotActivityTable
        items={[makeJob({ operation: "get_settlement_report", actionProposalId: "p-1" })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.getByRole("link", { name: "정산 리포트 결과 보기" })).toBeInTheDocument();
  });

  it("표에는 sr-only 이름표(caption)가 있다", () => {
    const { container } = render(
      <BotActivityTable items={[makeJob()]} includeSucceeded onToggleSucceeded={vi.fn()} />
    );
    const caption = container.querySelector("caption");
    expect(caption).toHaveTextContent("봇 활동 내역");
    expect(caption).toHaveClass("sr-only");
  });

  it("payloadUnreadable 행은 작업을 「알 수 없음」으로 보여준다", () => {
    render(
      <BotActivityTable
        items={[makeJob({ operation: "unknown", payloadUnreadable: true })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.getByText("알 수 없음")).toBeInTheDocument();
  });

  it("요약이 없으면 failureCode 를 대신 보여준다", () => {
    render(
      <BotActivityTable
        items={[makeJob({ resultSummary: null, failureCode: "TIMEOUT" })]}
        includeSucceeded
        onToggleSucceeded={vi.fn()}
      />
    );
    expect(screen.getByText("TIMEOUT")).toBeInTheDocument();
  });

  // ⛔ 이 토글을 다시 평범한 버튼으로 만들지 말 것 — 켜진 상태가 `aria-pressed` 에만
  // 있으면 눈으로 보는 사람은 필터가 걸린 줄 모른다. `Toggle` 프리미티브가 그 상태를
  // `data-state=on` + 배경으로도 그린다.
  it("「완료 포함」 토글은 눌린 상태를 aria-pressed·data-state 로 함께 알린다", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <BotActivityTable items={[makeJob()]} includeSucceeded={false} onToggleSucceeded={onToggle} />
    );
    const toggle = screen.getByRole("button", { name: "완료 포함", pressed: false });
    expect(toggle).toHaveAttribute("data-state", "off");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <BotActivityTable items={[makeJob()]} includeSucceeded onToggleSucceeded={onToggle} />
    );
    const pressed = screen.getByRole("button", { name: "완료 포함", pressed: true });
    expect(pressed).toHaveAttribute("data-state", "on");
  });
});
