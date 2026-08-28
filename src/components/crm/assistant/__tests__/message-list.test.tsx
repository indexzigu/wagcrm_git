/**
 * MessageList — 기안 카드 목록 + READ 리치 렌더 배선 (청사진 §1/§2, §3-#6, §4, §7).
 *
 * ProposalCard는 react-query GET fetch를 하므로 실제 컴포넌트를 모킹해 message-list의
 * 배선 로직(어떤 message에 몇 개의 카드가 뜨는지)만 검증한다. tool-result-views는
 * 실제 레지스트리를 사용해 리치 블록이 EvidenceTable 위에 오는지 검증한다.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "../message-list";
import type { AssistantMessage } from "../types";

vi.mock("../proposal-card", () => ({
  ProposalCard: ({ id }: { id: string }) => <div data-testid={`proposal-card-${id}`}>카드:{id}</div>,
}));

function baseMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "m1",
    role: "model",
    text: "결과입니다.",
    createdAt: "2026-07-06T00:00:00Z",
    ...overrides,
  };
}

describe("MessageList — 기안 카드 배선", () => {
  it("actionProposalIds가 있는 메시지에 ID별 ProposalCard를 렌더한다", () => {
    render(
      <MessageList
        messages={[baseMessage({ actionProposalIds: ["p1", "p2"] })]}
      />
    );

    expect(screen.getByTestId("proposal-card-p1")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-card-p2")).toBeInTheDocument();
  });

  it("actionProposalIds가 빈 배열이면 카드를 렌더하지 않는다", () => {
    render(<MessageList messages={[baseMessage({ actionProposalIds: [] })]} />);
    expect(screen.queryByTestId(/proposal-card-/)).not.toBeInTheDocument();
  });

  it("actionProposalIds가 없는 메시지는 카드 없이 정상 렌더된다(기안만 없고 텍스트는 그대로)", () => {
    render(<MessageList messages={[baseMessage()]} />);
    expect(screen.getByText("결과입니다.")).toBeInTheDocument();
    expect(screen.queryByTestId(/proposal-card-/)).not.toBeInTheDocument();
  });

  it("user 메시지에는 actionProposalIds가 있어도 카드가 뜨지 않는다(모델 메시지 전용)", () => {
    render(
      <MessageList
        messages={[
          { id: "u1", role: "user", text: "질문", createdAt: "2026-07-06T00:00:00Z", actionProposalIds: ["p1"] },
        ]}
      />
    );
    expect(screen.queryByTestId(/proposal-card-/)).not.toBeInTheDocument();
  });
});

describe("MessageList — READ 리치 렌더 + EvidenceTable 공존", () => {
  it("ok && data가 있고 레지스트리에 있는 toolCall은 EvidenceTable 위에 리치 블록을 렌더한다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "search_deals",
                args: {},
                ok: true,
                data: {
                  items: [
                    {
                      id: "deal1",
                      dealName: "락토핏 골드",
                      brandName: "락토핏",
                      status: "NEGOTIATING",
                      sellingPrice: 1000,
                      costPrice: 500,
                      partnerName: "파트너A",
                      updatedAt: "2026-07-01T00:00:00Z",
                    },
                  ],
                  count: 1,
                  truncated: false,
                },
                error: null,
                evidence: { dataSources: ["Deal"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    // 리치 블록 핵심 필드
    expect(screen.getByText("락토핏 골드")).toBeInTheDocument();
    // EvidenceTable도 항상 유지된다 — "근거 데이터" 헤더로 확인
    expect(screen.getByText("근거 데이터")).toBeInTheDocument();
  });

  it("data가 없거나(truncated) 레지스트리에 없는 toolName은 리치 블록 없이 EvidenceTable만 유지한다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "unknown_future_tool",
                args: {},
                ok: true,
                data: { anything: 1 },
                error: null,
                evidence: { dataSources: ["Foo"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    expect(screen.getByText("근거 데이터")).toBeInTheDocument();
    // 미지 tool은 리치뷰가 없으므로 EvidenceTable의 도구명(원문) 렌더만 확인
    expect(screen.getByText("unknown_future_tool")).toBeInTheDocument();
  });

  it("ok=false toolCall은 리치 블록을 렌더하지 않는다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "search_deals",
                args: {},
                ok: false,
                data: null,
                error: { code: "NOT_FOUND", message: "없음" },
                evidence: { dataSources: [], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    expect(screen.getByText("근거 데이터")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeInTheDocument(); // EvidenceTable만
  });

  it("toolCallsTruncated 메시지는 리치 블록 없이 기존 절삭 안내를 유지한다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "search_deals",
                args: {},
                ok: true,
                data: null,
                error: null,
                evidence: { dataSources: ["Deal"], query: {} },
              },
            ],
            toolCallsTruncated: true,
          }),
        ]}
      />
    );

    expect(screen.getByText(/저장 용량\(64KB\) 초과로 요약 저장/)).toBeInTheDocument();
  });
});

describe("MessageList — 두 기능 상호 독립 (critic 회귀 검증)", () => {
  it("기안 카드만 있는 메시지(toolCalls 없음)가 정상 렌더된다", () => {
    render(
      <MessageList
        messages={[baseMessage({ actionProposalIds: ["p1"], toolCalls: undefined })]}
      />
    );
    expect(screen.getByTestId("proposal-card-p1")).toBeInTheDocument();
    expect(screen.queryByText("근거 데이터")).not.toBeInTheDocument();
  });

  it("toolCalls만 있는 메시지(actionProposalIds 없음)가 정상 렌더된다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            actionProposalIds: undefined,
            toolCalls: [
              {
                toolName: "get_pipeline_status",
                args: {},
                ok: true,
                data: {
                  statusCounts: [{ status: "ACTIVE", count: 2 }],
                  totalCount: 2,
                  campaigns: [],
                },
                error: null,
                evidence: { dataSources: ["SalesCampaign"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    expect(screen.getByText("근거 데이터")).toBeInTheDocument();
    expect(screen.queryByTestId(/proposal-card-/)).not.toBeInTheDocument();
  });

  it("기안+toolCalls가 모두 있는 메시지도 둘 다 정상 렌더된다", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            actionProposalIds: ["p1"],
            toolCalls: [
              {
                toolName: "search_deals",
                args: {},
                ok: true,
                data: { items: [], count: 0, truncated: false },
                error: null,
                evidence: { dataSources: ["Deal"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    expect(screen.getByTestId("proposal-card-p1")).toBeInTheDocument();
    expect(screen.getByText("근거 데이터")).toBeInTheDocument();
  });
});

describe("MessageList — onQuickAction 관통 (§7-2)", () => {
  it("onQuickAction prop을 ToolResultView(리치 렌더 블록)로 전달해 행 액션 클릭 시 호출된다", () => {
    const onQuickAction = vi.fn();
    render(
      <MessageList
        onQuickAction={onQuickAction}
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "get_settlement_report",
                args: {},
                ok: true,
                data: {
                  period: "2026-07",
                  summary: { totalRevenue: 100, totalMargin: 10, totalSellerPayouts: 20, campaignCount: 1 },
                  campaigns: [
                    {
                      id: "camp1",
                      dealName: "락토핏 골드",
                      brandName: "락토핏",
                      sellerName: "셀러A",
                      actualSales: 100,
                      sellerPayoutAmount: 20,
                      netMarginAmount: 10,
                      state: "pending",
                      isDepositReceived: false,
                      isPayoutCompleted: false,
                      depositReceivedAt: null,
                      payoutCompletedAt: null,
                    },
                  ],
                  stateCounts: { pending: 1, confirmed: 0, paid: 0 },
                },
                error: null,
                evidence: { dataSources: ["SalesCampaign"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "입금확정 기안" }));
    expect(onQuickAction).toHaveBeenCalledWith(
      '"락토핏 골드" 캠페인(ID: camp1)의 정산 입금확정 처리를 기안해줘'
    );
  });

  it("onQuickAction prop 미제공 시 행 액션 버튼이 렌더되지 않는다(기존 리치 렌더 회귀 0)", () => {
    render(
      <MessageList
        messages={[
          baseMessage({
            toolCalls: [
              {
                toolName: "get_settlement_report",
                args: {},
                ok: true,
                data: {
                  period: "2026-07",
                  summary: { totalRevenue: 100, totalMargin: 10, totalSellerPayouts: 20, campaignCount: 1 },
                  campaigns: [
                    {
                      id: "camp1",
                      dealName: "락토핏 골드",
                      brandName: "락토핏",
                      sellerName: "셀러A",
                      actualSales: 100,
                      sellerPayoutAmount: 20,
                      netMarginAmount: 10,
                      state: "pending",
                      isDepositReceived: false,
                      isPayoutCompleted: false,
                      depositReceivedAt: null,
                      payoutCompletedAt: null,
                    },
                  ],
                  stateCounts: { pending: 1, confirmed: 0, paid: 0 },
                },
                error: null,
                evidence: { dataSources: ["SalesCampaign"], query: {} },
              },
            ],
          }),
        ]}
      />
    );

    expect(screen.queryByRole("button", { name: "입금확정 기안" })).not.toBeInTheDocument();
    expect(screen.getByText("락토핏 골드")).toBeInTheDocument();
  });
});

describe("MessageList — 기존 회귀 0", () => {
  it("빈 메시지 목록이면 안내 문구를 보여준다", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText(/자연어로 물어보세요/)).toBeInTheDocument();
  });

  it("isClarification 뱃지를 그대로 렌더한다", () => {
    render(<MessageList messages={[baseMessage({ isClarification: true })]} />);
    expect(screen.getByText("추가 정보 필요")).toBeInTheDocument();
  });

  it("lintWarnings가 있으면 경고 문구를 그대로 렌더한다", () => {
    render(<MessageList messages={[baseMessage({ lintWarnings: ["확정 단정 표현"] })]} />);
    expect(screen.getByText(/확정 단정 표현이 포함되었을 수 있습니다/)).toBeInTheDocument();
  });

  it("user 메시지는 오른쪽 정렬 말풍선으로 렌더된다(회귀 확인용 텍스트만 검증)", () => {
    render(
      <MessageList
        messages={[{ id: "u1", role: "user", text: "안녕하세요", createdAt: "2026-07-06T00:00:00Z" }]}
      />
    );
    expect(screen.getByText("안녕하세요")).toBeInTheDocument();
  });
});
