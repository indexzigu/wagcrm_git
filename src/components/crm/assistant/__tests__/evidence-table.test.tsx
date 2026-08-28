/**
 * evidence-table — 이번 턴 도구 호출의 근거 표(청사진 §3).
 *
 * 상태 칸은 성공/실패 이분 판정이다. 완료 hue 계약(P8 §4 — 브랜드 네이비 틴트를
 * 판정 의미로 쓰는 것 금지, 오너 승인 2026-08-26)이 이 칸에도 걸린다.
 * ⛔ 「조회 완료」를 status-active(네이비)로 되돌리면 여기서 빨강.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceTable } from "../evidence-table";
import type { AssistantToolCallView } from "../types";

function makeCall(overrides: Partial<AssistantToolCallView> = {}): AssistantToolCallView {
  return {
    toolName: "get_settlement_report",
    args: { month: "2026-07" },
    ok: true,
    data: null,
    error: null,
    evidence: { dataSources: ["campaign"], query: { month: "2026-07" } },
    ...overrides,
  };
}

describe("EvidenceTable", () => {
  it("호출이 없으면 렌더하지 않는다", () => {
    const { container } = render(<EvidenceTable toolCalls={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("성공 행은 도구 라벨과 근거 데이터를 보여준다", () => {
    render(<EvidenceTable toolCalls={[makeCall()]} />);
    expect(screen.getByText("정산 리포트")).toBeInTheDocument();
    expect(screen.getByText("campaign")).toBeInTheDocument();
  });

  it("성공 배지는 status-success 다 (완료 hue 계약)", () => {
    render(<EvidenceTable toolCalls={[makeCall()]} />);
    expect(screen.getByText("조회 완료")).toHaveAttribute("data-variant", "status-success");
  });

  it("실패 행은 destructive 배지로 오류 라벨을 보여준다", () => {
    render(
      <EvidenceTable
        toolCalls={[makeCall({ ok: false, error: { code: "QUERY_FAILED", message: "boom" } })]}
      />
    );
    const badge = screen.getByText("조회 실패");
    expect(badge).toHaveAttribute("data-variant", "destructive");
    expect(screen.queryByText("조회 완료")).not.toBeInTheDocument();
  });
});
