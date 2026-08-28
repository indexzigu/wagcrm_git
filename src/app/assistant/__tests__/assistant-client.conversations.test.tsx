// @vitest-environment jsdom
/**
 * AssistantClient — 채팅 영속화 클라이언트 배선 회귀 테스트 (Phase 5 청사진 v2 §3).
 *
 * 검증 대상:
 * - 마운트 시 GET /api/assistant/conversations로 목록을 불러와 ConversationList에 전달한다.
 * - 대화 클릭 시 GET /api/assistant/conversations/[id]로 메시지를 불러와 재수화한다
 *   (text+toolCalls → 기존 EvidenceTable 재렌더 가능해야 함).
 * - "새 대화" 클릭 시 현재 대화 상태를 초기화한다.
 * - 전송 시 conversationId를 함께 보내고, 응답의 conversationId를 상태에 유지한다.
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

// 실제 앱 트리는 루트 layout.tsx의 Providers(QueryClientProvider)로 감싸져 있다
// (approval-inbox.tsx뿐 아니라 재수화된 기안 카드 ProposalCard도 react-query를 쓴다,
// 청사진 §1-1/§3-#6). 이 단위 테스트는 AssistantClient만 단독 렌더하므로 동일한
// 트리를 재현하기 위해 QueryClientProvider로 감싼다(동작 변화 아님 — 테스트 하네스 정합).
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("AssistantClient — 채팅 영속화 배선 (§3)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("마운트 시 대화 목록을 불러와 ConversationList에 표시한다", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(
          jsonResponse({
            conversations: [
              { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);

    await waitFor(() => {
      expect(screen.getByText("이전 대화")).toBeInTheDocument();
    });
  });

  it("대화 항목 클릭 시 메시지를 불러와 재수화하고(text·toolCalls 포함) 스크롤을 하단으로 고정한다", async () => {
    const scrollToMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(
          jsonResponse({
            conversations: [
              { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
            ],
          })
        );
      }
      if (url === "/api/assistant/conversations/conv-1") {
        return Promise.resolve(
          jsonResponse({
            id: "conv-1",
            title: "이전 대화",
            messages: [
              {
                id: "m1",
                conversationId: "conv-1",
                role: "user",
                text: "이전 질문입니다",
                toolCalls: null,
                toolCallsTruncated: false,
                actionProposalIds: null,
                createdAt: "2026-07-06T00:00:00Z",
              },
              {
                id: "m2",
                conversationId: "conv-1",
                role: "model",
                text: "이전 답변입니다",
                toolCalls: [
                  {
                    toolName: "get_settlement_report",
                    args: { month: "2026-07" },
                    ok: true,
                    data: {},
                    error: null,
                    evidence: { dataSources: ["SalesCampaign"], query: {} },
                  },
                ],
                toolCallsTruncated: false,
                actionProposalIds: ["ap-1"],
                createdAt: "2026-07-06T00:01:00Z",
              },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);

    await waitFor(() => {
      expect(screen.getByText("이전 대화")).toBeInTheDocument();
    });

    Element.prototype.scrollTo = scrollToMock;
    fireEvent.click(screen.getByText("이전 대화"));

    await waitFor(() => {
      expect(screen.getByText("이전 질문입니다")).toBeInTheDocument();
      expect(screen.getByText("이전 답변입니다")).toBeInTheDocument();
    });

    // toolCalls가 재수화되어 EvidenceTable(도구명)이 다시 렌더링되어야 한다.
    expect(screen.getByText("정산 리포트")).toBeInTheDocument();
  });

  it("'새 대화' 클릭 시 현재 대화(메시지·conversationId)가 초기화된다", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(
          jsonResponse({
            conversations: [
              { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
            ],
          })
        );
      }
      if (url === "/api/assistant/conversations/conv-1") {
        return Promise.resolve(
          jsonResponse({
            id: "conv-1",
            title: "이전 대화",
            messages: [
              {
                id: "m1",
                conversationId: "conv-1",
                role: "user",
                text: "이전 질문입니다",
                toolCalls: null,
                toolCallsTruncated: false,
                actionProposalIds: null,
                createdAt: "2026-07-06T00:00:00Z",
              },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);

    await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());
    fireEvent.click(screen.getByText("이전 대화"));
    await waitFor(() => expect(screen.getByText("이전 질문입니다")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "새 대화" }));

    await waitFor(() => {
      expect(screen.queryByText("이전 질문입니다")).not.toBeInTheDocument();
    });
  });

  it("전송 시 conversationId를 함께 보내고, 응답의 conversationId를 상태에 유지한다", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/assistant") {
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        expect(parsedBody).toHaveProperty("conversationId");
        return Promise.resolve(
          jsonResponse({
            reply: "답변입니다",
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

    const textarea = screen.getByPlaceholderText("예: 이번 달 정산 현황 알려줘");
    fireEvent.change(textarea, { target: { value: "새 질문" } });
    fireEvent.click(screen.getByLabelText("전송"));

    await waitFor(() => {
      const assistantCall = fetchMock.mock.calls.find((call) => call[0] === "/api/assistant");
      expect(assistantCall).toBeDefined();
    });

    // 첫 전송 시 conversationId는 null(신규 대화)이었어야 하고, 이후 상태에 응답값이 반영된다.
    const firstAssistantCall = fetchMock.mock.calls.find((call) => call[0] === "/api/assistant");
    const sentBody = JSON.parse(String(firstAssistantCall?.[1]?.body ?? "{}"));
    expect(sentBody.conversationId).toBeNull();
  });

  // §5-1: 대화 삭제 — 삭제 성공 시 목록 갱신, 선택 중 대화 삭제 시 리셋.
  describe("대화 삭제 (§5-1)", () => {
    it("삭제 성공 시 DELETE를 호출하고 목록을 다시 불러온다(loadConversations 재호출)", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      let conversationsCallCount = 0;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/assistant/conversations") {
          conversationsCallCount += 1;
          return Promise.resolve(
            jsonResponse({
              conversations:
                conversationsCallCount === 1
                  ? [{ id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 }]
                  : [],
            })
          );
        }
        if (url === "/api/assistant/conversations/conv-1" && (!init || init.method === undefined)) {
          return Promise.resolve(jsonResponse({ id: "conv-1", title: "이전 대화", messages: [] }));
        }
        if (url === "/api/assistant/conversations/conv-1" && init?.method === "DELETE") {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      await waitFor(() => {
        const deleteCall = fetchMock.mock.calls.find(
          (call) => call[0] === "/api/assistant/conversations/conv-1" && call[1]?.method === "DELETE"
        );
        expect(deleteCall).toBeDefined();
      });

      await waitFor(() => {
        expect(screen.getByText(/저장된 대화가 없습니다/)).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });

    it("현재 선택 중인 대화를 삭제하면 새 대화 상태로 리셋된다(메시지·선택 초기화)", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/assistant/conversations") {
          return Promise.resolve(
            jsonResponse({
              conversations: [
                { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
              ],
            })
          );
        }
        if (url === "/api/assistant/conversations/conv-1" && init?.method === "DELETE") {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        if (url === "/api/assistant/conversations/conv-1") {
          return Promise.resolve(
            jsonResponse({
              id: "conv-1",
              title: "이전 대화",
              messages: [
                {
                  id: "m1",
                  conversationId: "conv-1",
                  role: "user",
                  text: "이전 질문입니다",
                  toolCalls: null,
                  toolCallsTruncated: false,
                  actionProposalIds: null,
                  createdAt: "2026-07-06T00:00:00Z",
                },
              ],
            })
          );
        }
        return Promise.resolve(jsonResponse({}));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      // 대화를 먼저 선택(재수화)한다 — 삭제 대상이 "현재 선택 중"인 상태를 만든다.
      fireEvent.click(screen.getByText("이전 대화"));
      await waitFor(() => expect(screen.getByText("이전 질문입니다")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      await waitFor(() => {
        expect(screen.queryByText("이전 질문입니다")).not.toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });

    it("삭제 실패 시 errorText를 표시한다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/assistant/conversations") {
          return Promise.resolve(
            jsonResponse({
              conversations: [
                { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
              ],
            })
          );
        }
        if (url === "/api/assistant/conversations/conv-1" && init?.method === "DELETE") {
          return Promise.resolve(jsonResponse({ error: "대화를 찾을 수 없습니다." }, false));
        }
        return Promise.resolve(jsonResponse({}));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      await waitFor(() => {
        expect(screen.getByText("대화를 찾을 수 없습니다.")).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });
  });

  // §5-2: 대화 이름 바꾸기 — 성공 시 목록 재조회(loadConversations).
  describe("대화 이름 바꾸기 (§5-2)", () => {
    it("이름 바꾸기 성공 시 PATCH를 호출하고 목록을 다시 불러온다(loadConversations 재호출)", async () => {
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("새 이름");
      let conversationsCallCount = 0;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/assistant/conversations") {
          conversationsCallCount += 1;
          return Promise.resolve(
            jsonResponse({
              conversations:
                conversationsCallCount === 1
                  ? [{ id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 }]
                  : [{ id: "conv-1", title: "새 이름", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 }],
            })
          );
        }
        if (url === "/api/assistant/conversations/conv-1" && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      await waitFor(() => {
        const patchCall = fetchMock.mock.calls.find(
          (call) => call[0] === "/api/assistant/conversations/conv-1" && call[1]?.method === "PATCH"
        );
        expect(patchCall).toBeDefined();
        expect(JSON.parse(String(patchCall?.[1]?.body ?? "{}"))).toEqual({ title: "새 이름" });
      });

      await waitFor(() => {
        expect(screen.getByText("새 이름")).toBeInTheDocument();
      });

      promptSpy.mockRestore();
    });

    it("이름 바꾸기 실패 시 errorText를 표시한다", async () => {
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("새 이름");
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/assistant/conversations") {
          return Promise.resolve(
            jsonResponse({
              conversations: [
                { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
              ],
            })
          );
        }
        if (url === "/api/assistant/conversations/conv-1" && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse({ error: "대화를 찾을 수 없습니다." }, false));
        }
        return Promise.resolve(jsonResponse({}));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      await waitFor(() => {
        expect(screen.getByText("대화를 찾을 수 없습니다.")).toBeInTheDocument();
      });

      promptSpy.mockRestore();
    });
  });

  // §5-3: 대화 검색 — 검색어 입력 후 300ms 디바운스 뒤 loadConversations(q)가 재조회된다.
  describe("대화 검색 (§5-3)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("검색어 입력 후 300ms 전에는 재조회하지 않고, 300ms가 지나면 q를 포함한 URL로 재조회한다", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === "/api/assistant/conversations") {
          return Promise.resolve(
            jsonResponse({
              conversations: [
                { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
              ],
            })
          );
        }
        return Promise.resolve(jsonResponse({ conversations: [] }));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      const initialCallCount = fetchMock.mock.calls.filter(
        (call) => String(call[0]).startsWith("/api/assistant/conversations")
      ).length;

      const searchInput = screen.getByPlaceholderText("대화 검색");
      fireEvent.change(searchInput, { target: { value: "정산" } });

      // 300ms 미만 경과 — 아직 재조회하지 않는다.
      await vi.advanceTimersByTimeAsync(200);
      const midCallCount = fetchMock.mock.calls.filter(
        (call) => String(call[0]).startsWith("/api/assistant/conversations")
      ).length;
      expect(midCallCount).toBe(initialCallCount);

      // 300ms 경과 — q를 포함한 URL로 재조회한다.
      await vi.advanceTimersByTimeAsync(150);

      const searchCall = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).startsWith("/api/assistant/conversations?") &&
          String(call[0]).includes("q=")
      );
      expect(searchCall).toBeDefined();
      expect(String(searchCall?.[0])).toContain(encodeURIComponent("정산"));
    });

    it("검색어를 지우면(빈 문자열) 디바운스 후 필터 없는 최근 목록으로 복귀한다", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url === "/api/assistant/conversations") {
          return Promise.resolve(
            jsonResponse({
              conversations: [
                { id: "conv-1", title: "이전 대화", updatedAt: "2026-07-06T00:00:00Z", messageCount: 2 },
              ],
            })
          );
        }
        return Promise.resolve(jsonResponse({ conversations: [] }));
      });

      renderWithQueryClient(<AssistantClient />);
      await waitFor(() => expect(screen.getByText("이전 대화")).toBeInTheDocument());

      const searchInput = screen.getByPlaceholderText("대화 검색");
      fireEvent.change(searchInput, { target: { value: "정산" } });
      await vi.advanceTimersByTimeAsync(300);

      fireEvent.change(searchInput, { target: { value: "" } });
      await vi.advanceTimersByTimeAsync(300);

      const lastCall = fetchMock.mock.calls
        .filter((call) => String(call[0]).startsWith("/api/assistant/conversations"))
        .at(-1);
      expect(lastCall?.[0]).toBe("/api/assistant/conversations");
    });
  });
});
