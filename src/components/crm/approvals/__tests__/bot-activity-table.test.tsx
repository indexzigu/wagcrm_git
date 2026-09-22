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

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
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
    expect(screen.getByRole("link", { name: "결과" })).toHaveAttribute(
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
    expect(screen.queryByRole("link", { name: "결과" })).not.toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
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

  it("「완료 포함」 토글은 aria-pressed 로 현재 상태를 알리고 클릭하면 콜백을 부른다", () => {
    const onToggle = vi.fn();
    render(
      <BotActivityTable items={[makeJob()]} includeSucceeded={false} onToggleSucceeded={onToggle} />
    );
    const toggle = screen.getByRole("button", { name: "완료 포함" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
