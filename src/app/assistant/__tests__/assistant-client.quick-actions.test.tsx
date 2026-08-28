// @vitest-environment jsdom
/**
 * AssistantClient — 퀵 액션 칩 (청사진 §7-1/§7-3, v1.3 追記).
 *
 * §7-1: 빈 대화(messages.length === 0 && !isLoadingMessages)일 때 입력창 위에 제안 칩 3개를
 * 렌더한다. 클릭 = 즉시 전송(입력창 채우기 아님) — handleSend에서 추출한 sendMessage(text)를
 * 칩과 기존 전송 버튼이 공유한다.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/crm/assistant/approval-inbox", () => ({
  ApprovalInbox: () => <div data-testid="approval-inbox-stub" />,
}));

import { AssistantClient } from "../assistant-client";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("AssistantClient — 퀵 액션 칩 (§7-1)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("빈 대화(메시지 0개)일 때 제안 칩 3개를 렌더한다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "파이프라인 현황 보여줘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최근 7일 주문 현황 알려줘" })).toBeInTheDocument();
  });

  it("칩 클릭 시 해당 텍스트로 즉시 전송한다(입력창을 채우는 것이 아니라 바로 요청)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/assistant") {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody.message).toBe("이번달 정산 현황 알려줘");
        return Promise.resolve(
          jsonResponse({
            reply: "정산 현황입니다",
            toolCalls: [],
            isClarification: false,
            actionProposalId: null,
            actionProposalIds: [],
            conversationId: "conv-new-1",
            lintWarnings: [],
            model: "gemini-3.6-flash",
            latencyMs: 100,
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" }));

    await waitFor(() => {
      const assistantCall = fetchMock.mock.calls.find((call) => call[0] === "/api/assistant");
      expect(assistantCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByText("이번달 정산 현황 알려줘")).toBeInTheDocument();
      expect(screen.getByText("정산 현황입니다")).toBeInTheDocument();
    });

    // 입력창은 채워지지 않고 비어 있어야 한다.
    const textarea = screen.getByPlaceholderText("예: 이번 달 정산 현황 알려줘") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("isSending 중에는 칩이 disabled 처리된다 (전송 중 '새 대화'로 돌아와 칩이 재노출된 경우)", async () => {
    // 칩은 messages.length===0에서만 렌더되므로, isSending && 빈 대화가 동시에 참이 되는
    // 실제 도달 시나리오는: 전송 중(응답 대기, isSending=true) 사용자가 "새 대화"를 눌러
    // 현재 뷰의 메시지를 비우는 경우다(레이스 가드로 이전 응답은 무시되지만 isSending은
    // 응답 도착 시 finally에서 꺼진다 — 그 사이 칩이 다시 보이며 disabled여야 한다).
    let resolveAssistant: (value: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/assistant") {
        return new Promise((resolve) => {
          resolveAssistant = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" }));
    await waitFor(() => expect(screen.getByText("이번달 정산 현황 알려줘")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "새 대화" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "파이프라인 현황 보여줘" })).toBeDisabled();
    });

    resolveAssistant(
      jsonResponse({
        reply: "완료",
        toolCalls: [],
        isClarification: false,
        actionProposalId: null,
        actionProposalIds: [],
        conversationId: "conv-new-1",
        lintWarnings: [],
        model: "gemini-3.6-flash",
        latencyMs: 100,
      })
    );
  });

  it("메시지가 생기면(대화 시작 후) 제안 칩이 사라진다", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/assistant") {
        return Promise.resolve(
          jsonResponse({
            reply: "정산 현황입니다",
            toolCalls: [],
            isClarification: false,
            actionProposalId: null,
            actionProposalIds: [],
            conversationId: "conv-new-1",
            lintWarnings: [],
            model: "gemini-3.6-flash",
            latencyMs: 100,
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" }));

    await waitFor(() => {
      expect(screen.getByText("정산 현황입니다")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "이번달 정산 현황 알려줘" })).not.toBeInTheDocument();
  });
});
