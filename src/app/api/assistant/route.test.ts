import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const runAgentMock = vi.fn();
const createProposalMock = vi.fn();
const transitionProposalMock = vi.fn();
const executeWriteActionMock = vi.fn();
const transactionMock = vi.fn();
const applyWriteActionEffectsMock = vi.fn();
const getAgentLaneUserIdMock = vi.fn();
const createConversationMock = vi.fn();
const findWithMessagesMock = vi.fn();
const appendTurnsMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
    },
  }),
}));

vi.mock("@/lib/agent/agent-loop", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    create: (...args: unknown[]) => createProposalMock(...args),
    transition: (...args: unknown[]) => transitionProposalMock(...args),
  },
}));

vi.mock("@/lib/agent/write-executor", () => ({
  executeWriteAction: (...args: unknown[]) => executeWriteActionMock(...args),
}));

vi.mock("@/lib/agent/write-action-effects", () => ({
  applyWriteActionEffects: (...args: unknown[]) => applyWriteActionEffectsMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: (...args: unknown[]) => transactionMock(...args),
  }),
}));

vi.mock("@/lib/agent-lane", () => ({
  getAgentLaneUserId: (...args: unknown[]) => getAgentLaneUserIdMock(...args),
}));

vi.mock("@/repositories/assistantConversationRepository", () => ({
  AssistantConversationRepository: {
    create: (...args: unknown[]) => createConversationMock(...args),
    findWithMessages: (...args: unknown[]) => findWithMessagesMock(...args),
    appendTurns: (...args: unknown[]) => appendTurnsMock(...args),
  },
}));

import { POST } from "./route";

// Phase 5 자동승인 청사진 §3: $transaction(callback)을 실제로 실행해 callback 내부에서
// executeWriteAction(action,args,"AGENT",tx) + ActionProposalRepository.transition(...,tx)가
// 호출되는 흐름을 재현한다. tx 인자로는 fakeTx를 넘긴다(테스트에서 식별용으로만 쓰임).
const fakeTx = { __fakeTx: true } as unknown;

function setupSuccessfulTransaction() {
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(fakeTx));
}

function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function agentResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    finalText: "이번 달 정산 요약입니다.",
    toolCalls: [
      {
        toolName: "get_settlement_report",
        args: { month: "2026-07" },
        result: {
          ok: true,
          data: {},
          evidence: { dataSources: ["SalesCampaign"], query: { month: "2026-07" } },
        },
      },
    ],
    writeIntents: [],
    isClarification: false,
    stepCount: 2,
    usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    model: "gemini-3.6-flash",
    latencyMs: 120,
    lintWarnings: [],
    ...overrides,
  };
}

describe("POST /api/assistant", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    runAgentMock.mockReset();
    createProposalMock.mockReset();
    transitionProposalMock.mockReset();
    executeWriteActionMock.mockReset();
    transactionMock.mockReset();
    applyWriteActionEffectsMock.mockReset();
    getAgentLaneUserIdMock.mockReset();
    createConversationMock.mockReset();
    findWithMessagesMock.mockReset();
    appendTurnsMock.mockReset();

    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    // 기본값: 에이전트 레인 비활성(일반 인증 사용자 경로) — 개별 테스트가 필요 시 override.
    getAgentLaneUserIdMock.mockReturnValue(null);
    createConversationMock.mockResolvedValue({ id: "conv-new-1" });
    appendTurnsMock.mockResolvedValue({ truncated: false });
  });

  it("m4: ActionProposal 기록(create)이 실패해도 조회 답변(finalText)은 정상 응답으로 반환된다", async () => {
    runAgentMock.mockResolvedValue(agentResult());
    createProposalMock.mockRejectedValue(new Error("Prisma 연결 실패: 내부 DSN 노출 위험 메시지"));

    const res = await POST(makeRequest({ message: "이번 달 정산 알려줘", history: [] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reply).toBe("이번 달 정산 요약입니다.");
    expect(body.actionProposalId).toBeNull();
    expect(transitionProposalMock).not.toHaveBeenCalled();
  });

  it("m4: ActionProposal 기록(transition)이 실패해도 조회 답변은 정상 응답으로 반환된다", async () => {
    runAgentMock.mockResolvedValue(agentResult());
    createProposalMock.mockResolvedValue({ id: "proposal-1" });
    transitionProposalMock.mockRejectedValue(new Error("Illegal transition"));

    const res = await POST(makeRequest({ message: "이번 달 정산 알려줘", history: [] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reply).toBe("이번 달 정산 요약입니다.");
    expect(body.actionProposalId).toBeNull();
  });

  it("M1+M2: history가 12턴을 초과하면 최근 12턴으로 절삭되어 runAgent에 전달된다", async () => {
    runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], isClarification: false }));

    const longHistory = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "model",
      text: `turn-${i}`,
    }));

    await POST(makeRequest({ message: "질문", history: longHistory }));

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const passedHistory = runAgentMock.mock.calls[0][1] as Array<{ text: string }>;
    expect(passedHistory).toHaveLength(12);
    expect(passedHistory[0].text).toBe("turn-8");
    expect(passedHistory.at(-1)?.text).toBe("turn-19");
  });

  it("M1+M2: history 각 턴의 text가 4000자를 초과하면 뒤에서부터 4000자로 절삭된다", async () => {
    runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], isClarification: false }));

    const longText = "가".repeat(5000);
    await POST(makeRequest({ message: "질문", history: [{ role: "user", text: longText }] }));

    const passedHistory = runAgentMock.mock.calls[0][1] as Array<{ text: string }>;
    expect(passedHistory[0].text).toHaveLength(4000);
    expect(passedHistory[0].text).toBe(longText.slice(-4000));
  });

  it("m6+m7: 에이전트 실행 중 예외가 발생하면 원본 에러 메시지 대신 고정 문구를 반환한다", async () => {
    runAgentMock.mockRejectedValue(new Error("Gemini API 오류 (status=500): 내부 diagnostic dump"));

    const res = await POST(makeRequest({ message: "질문", history: [] }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("요청 처리 중 오류가 발생했습니다.");
    expect(body.error).not.toContain("Gemini");
    expect(body.error).not.toContain("diagnostic");
  });

  it("정상 흐름: 도구 실행 성공 시 ActionProposal이 기록되고 actionProposalId가 반환된다", async () => {
    runAgentMock.mockResolvedValue(agentResult());
    createProposalMock.mockResolvedValue({ id: "proposal-1" });
    transitionProposalMock.mockResolvedValue({ id: "proposal-1" });

    const res = await POST(makeRequest({ message: "이번 달 정산 알려줘", history: [] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.actionProposalId).toBe("proposal-1");
    expect(createProposalMock).toHaveBeenCalledTimes(1);
    expect(transitionProposalMock).toHaveBeenCalledTimes(1);
  });

  describe("WRITE 기안 생성 (Phase 5 HITL §0-1/§0-2)", () => {
    function writeIntentResult(overrides: Partial<Record<string, unknown>> = {}) {
      return agentResult({
        finalText: "메모 승인 대기 기안을 생성했습니다.",
        toolCalls: [
          {
            toolName: "add_entity_memo",
            args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
            result: {
              ok: true,
              data: {
                writeIntent: {
                  action: "add_entity_memo",
                  args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
                  summary: "딜(deal-1)에 메모 추가: \"재입고 확인\"",
                  targetEntityType: "DEAL",
                  targetEntityId: "deal-1",
                },
              },
              evidence: { dataSources: [], query: {} },
            },
          },
        ],
        writeIntents: [
          {
            action: "add_entity_memo",
            args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
            summary: '딜(deal-1)에 메모 추가: "재입고 확인"',
            targetEntityType: "DEAL",
            targetEntityId: "deal-1",
          },
        ],
        ...overrides,
      });
    }

    it("writeIntent가 있으면 READ 자동-EXECUTED 경로 대신 WRITE 기안을 생성하고 PENDING_APPROVAL로 전이한다", async () => {
      runAgentMock.mockResolvedValue(writeIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-write-1" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-write-1", status: "PENDING_APPROVAL" });

      const res = await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(createProposalMock).toHaveBeenCalledTimes(1);
      const createArgs = createProposalMock.mock.calls[0][0];
      expect(createArgs.kind).toBe("WRITE");
      expect(createArgs.status).toBe("DRAFT");
      expect(createArgs.createdBy).toBe("user-1");
      expect(createArgs.targetEntityType).toBe("DEAL");
      expect(createArgs.targetEntityId).toBe("deal-1");

      expect(transitionProposalMock).toHaveBeenCalledWith(
        "proposal-write-1",
        "PENDING_APPROVAL",
        expect.objectContaining({ actor: "user-1" })
      );

      // 채팅 영속화 §2-1: 복수 actionProposalIds가 응답에 추가되었다(GUI 기안 카드
      // 재수화 선행 요구, plan-critic #5). pendingApprovalCount는 여전히 미사용(m4 YAGNI,
      // ApprovalInbox는 독립 폴링으로 목록을 갱신) — 단수 actionProposalId(첫 건)도 하위호환 유지.
      expect(body.actionProposalId).toBe("proposal-write-1");
      expect(body.actionProposalIds).toEqual(["proposal-write-1"]);
      expect(body.pendingApprovalCount).toBeUndefined();
    });

    it("writeIntent가 여러 건이면 각각 별도의 WRITE 기안을 생성한다", async () => {
      // add_entity_memo는 Phase 5 자동승인 화이트리스트 대상이므로, 이 테스트는 자동실행
      // 인프라(executeWriteAction/$transaction)도 함께 준비해 자동 EXECUTED까지 회귀 없이
      // 진행되는지 확인한다(§0-1/§0-2 본연의 검증 대상인 "기안 2건 생성"은 그대로 유지).
      runAgentMock.mockResolvedValue(
        writeIntentResult({
          writeIntents: [
            {
              action: "add_entity_memo",
              args: { entityType: "DEAL", entityId: "deal-1", content: "메모1" },
              summary: "메모1",
              targetEntityType: "DEAL",
              targetEntityId: "deal-1",
            },
            {
              action: "add_entity_memo",
              args: { entityType: "CAMPAIGN", entityId: "camp-1", content: "메모2" },
              summary: "메모2",
              targetEntityType: "CAMPAIGN",
              targetEntityId: "camp-1",
            },
          ],
        })
      );
      createProposalMock
        .mockResolvedValueOnce({ id: "proposal-a" })
        .mockResolvedValueOnce({ id: "proposal-b" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-x", status: "PENDING_APPROVAL" });
      setupSuccessfulTransaction();
      executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록" });

      const res = await POST(makeRequest({ message: "메모 두 개 남겨줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(createProposalMock).toHaveBeenCalledTimes(2);
      // 단수 actionProposalId는 첫 번째로 생성된 기안 ID를 반영한다(하위호환 유지).
      expect(body.actionProposalId).toBe("proposal-a");
    });

    it("writeIntent가 있으면 READ 자동-EXECUTED용 kind:READ 기안은 생성하지 않는다", async () => {
      runAgentMock.mockResolvedValue(writeIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-write-1" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-write-1", status: "PENDING_APPROVAL" });
      setupSuccessfulTransaction();
      executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록" });

      await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));

      for (const call of createProposalMock.mock.calls) {
        expect(call[0].kind).not.toBe("READ");
      }
      // 이 테스트의 본연의 목적은 "READ 자동-EXECUTED 기안 경로가 별도로 타지 않는다"이다.
      // add_entity_memo 자체는 자동승인 대상이라 PENDING_APPROVAL이 최초 전이로 반드시
      // 호출되어야 한다(그 뒤 자동으로 APPROVED/EXECUTED까지 이어지는 것은 별도 테스트가 검증).
      const toStatuses = transitionProposalMock.mock.calls.map((call) => call[1]);
      expect(toStatuses[0]).toBe("PENDING_APPROVAL");
      expect(toStatuses).not.toContain("REJECTED");
    });

    it("WRITE 기안 생성이 실패해도 finalText는 정상 응답으로 반환된다 (m4와 동일한 격리 원칙)", async () => {
      runAgentMock.mockResolvedValue(writeIntentResult());
      createProposalMock.mockRejectedValue(new Error("DB 오류"));

      const res = await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("메모 승인 대기 기안을 생성했습니다.");
      expect(body.actionProposalId).toBeNull();
    });
  });

  describe("자동승인 실행 경로 (Phase 5 자동승인 화이트리스트 청사진 v2 §3)", () => {
    function memoIntentResult(overrides: Partial<Record<string, unknown>> = {}) {
      return agentResult({
        finalText: "메모를 기록했습니다.",
        toolCalls: [],
        writeIntents: [
          {
            action: "add_entity_memo",
            args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
            summary: '딜(deal-1)에 메모 추가: "재입고 확인"',
            targetEntityType: "DEAL",
            targetEntityId: "deal-1",
          },
        ],
        ...overrides,
      });
    }

    function settlementIntentResult(overrides: Partial<Record<string, unknown>> = {}) {
      return agentResult({
        finalText: "정산 확정 기안을 생성했습니다.",
        toolCalls: [],
        writeIntents: [
          {
            action: "confirm_settlement",
            args: { campaignId: "camp-1", target: "deposit" },
            summary: "캠페인(camp-1) 입금확정",
            targetEntityType: "CAMPAIGN",
            targetEntityId: "camp-1",
          },
        ],
        ...overrides,
      });
    }

    function dealStatusIntentResult(overrides: Partial<Record<string, unknown>> = {}) {
      return agentResult({
        finalText: "딜 상태 변경 기안을 생성했습니다.",
        toolCalls: [],
        writeIntents: [
          {
            action: "change_deal_status",
            args: { dealId: "deal-2", newStatus: "NEGOTIATING" },
            summary: "딜(deal-2) 상태 변경",
            targetEntityType: "DEAL",
            targetEntityId: "deal-2",
          },
        ],
        ...overrides,
      });
    }

    it("memo intent(자동승인 대상): PENDING_APPROVAL→APPROVED→EXECUTED 순서로 전이하고 executeWriteAction의 3번째 인자는 AGENT다", async () => {
      runAgentMock.mockResolvedValue(memoIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-memo-1" });
      transitionProposalMock
        .mockResolvedValueOnce({ id: "proposal-memo-1", status: "PENDING_APPROVAL" }) // 1) PENDING_APPROVAL
        .mockResolvedValueOnce({ id: "proposal-memo-1", status: "APPROVED" }) // 2) APPROVED
        .mockResolvedValueOnce({ id: "proposal-memo-1", status: "EXECUTED" }); // 3) EXECUTED
      setupSuccessfulTransaction();
      executeWriteActionMock.mockResolvedValue({
        refType: "DEAL",
        refId: "deal-1",
        summary: "DEAL deal-1에 메모 기록",
      });

      const res = await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("메모를 기록했습니다.");

      // create는 reviewRequired:false로 자동승인 대상임을 반영해야 한다.
      expect(createProposalMock).toHaveBeenCalledTimes(1);
      const createArgs = createProposalMock.mock.calls[0][0];
      expect(createArgs.reviewRequired).toBe(false);
      expect(createArgs.requestType).toBe("campaign_note_add");

      // transition 호출 순서: PENDING_APPROVAL(actor=userId) → APPROVED(actor=AGENT) → EXECUTED(actor=AGENT)
      expect(transitionProposalMock).toHaveBeenCalledTimes(3);
      expect(transitionProposalMock.mock.calls[0]).toEqual([
        "proposal-memo-1",
        "PENDING_APPROVAL",
        expect.objectContaining({ actor: "user-1" }),
      ]);
      expect(transitionProposalMock.mock.calls[1]).toEqual([
        "proposal-memo-1",
        "APPROVED",
        expect.objectContaining({ actor: "AGENT", expectedFrom: "PENDING_APPROVAL" }),
      ]);
      expect(transitionProposalMock.mock.calls[2]).toEqual([
        "proposal-memo-1",
        "EXECUTED",
        expect.objectContaining({ actor: "AGENT", expectedFrom: "APPROVED", tx: fakeTx }),
      ]);
      const executedCallData = transitionProposalMock.mock.calls[2][2] as Record<string, unknown>;
      expect((executedCallData.data as Record<string, unknown>)?.executedBy).toBe("AGENT");

      // executeWriteAction(action, args, "AGENT", tx)
      expect(executeWriteActionMock).toHaveBeenCalledWith(
        "add_entity_memo",
        { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
        "AGENT",
        fakeTx
      );

      expect(body.actionProposalId).toBe("proposal-memo-1");
    });

    it("settlement intent(alwaysManual): PENDING_APPROVAL에서 정지하고 자동실행(executeWriteAction)을 호출하지 않는다", async () => {
      runAgentMock.mockResolvedValue(settlementIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-settlement-1" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-settlement-1", status: "PENDING_APPROVAL" });

      const res = await POST(makeRequest({ message: "camp-1 입금확정 처리해줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      const createArgs = createProposalMock.mock.calls[0][0];
      expect(createArgs.reviewRequired).toBe(true);
      expect(createArgs.requestType).toBe("settlement_confirm");

      expect(transitionProposalMock).toHaveBeenCalledTimes(1);
      expect(transitionProposalMock).toHaveBeenCalledWith(
        "proposal-settlement-1",
        "PENDING_APPROVAL",
        expect.objectContaining({ actor: "user-1" })
      );
      expect(executeWriteActionMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
      expect(body.actionProposalId).toBe("proposal-settlement-1");
    });

    it("deal-status intent(alwaysManual): PENDING_APPROVAL에서 정지하고 자동실행을 호출하지 않는다", async () => {
      runAgentMock.mockResolvedValue(dealStatusIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-dealstatus-1" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-dealstatus-1", status: "PENDING_APPROVAL" });

      await POST(makeRequest({ message: "deal-2 상태 바꿔줘", history: [] }));

      const createArgs = createProposalMock.mock.calls[0][0];
      expect(createArgs.reviewRequired).toBe(true);
      expect(createArgs.requestType).toBe("crm_mutation");
      expect(transitionProposalMock).toHaveBeenCalledTimes(1);
      expect(executeWriteActionMock).not.toHaveBeenCalled();
    });

    it("혼재 턴(자동 memo 1 + 수동 settlement 1): 각각 올바른 종착 상태에 도달하고, 자동 처리 실패가 수동 기안 생성을 막지 않는다 (per-intent 격리)", async () => {
      runAgentMock.mockResolvedValue(
        agentResult({
          finalText: "요청을 처리했습니다.",
          toolCalls: [],
          writeIntents: [
            {
              action: "add_entity_memo",
              args: { entityType: "DEAL", entityId: "deal-1", content: "메모" },
              summary: "메모",
              targetEntityType: "DEAL",
              targetEntityId: "deal-1",
            },
            {
              action: "confirm_settlement",
              args: { campaignId: "camp-1", target: "deposit" },
              summary: "정산 확정",
              targetEntityType: "CAMPAIGN",
              targetEntityId: "camp-1",
            },
          ],
        })
      );

      createProposalMock
        .mockResolvedValueOnce({ id: "proposal-memo-x" }) // 1번째 intent(memo) create
        .mockResolvedValueOnce({ id: "proposal-settlement-x" }); // 2번째 intent(settlement) create

      // 1번째 intent(memo)의 자동실행 경로가 실패하도록 설정 — PENDING_APPROVAL 전이는 성공,
      // 이어지는 APPROVED 전이에서 실패를 유발한다.
      transitionProposalMock.mockImplementation(
        async (id: string, toStatus: string, _opts: Record<string, unknown>) => {
          if (id === "proposal-memo-x" && toStatus === "APPROVED") {
            throw new Error("APPROVED 전이 실패(테스트 유도)");
          }
          return { id, status: toStatus };
        }
      );

      const res = await POST(makeRequest({ message: "메모랑 정산확정 둘 다 처리해줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("요청을 처리했습니다.");

      // 두 intent 모두 create가 호출되어야 한다 — memo 자동실행 실패가 settlement 기안 생성을 막지 않음.
      expect(createProposalMock).toHaveBeenCalledTimes(2);
      const settlementCreateArgs = createProposalMock.mock.calls[1][0];
      expect(settlementCreateArgs.reviewRequired).toBe(true);
      expect(settlementCreateArgs.requestType).toBe("settlement_confirm");

      // settlement intent는 PENDING_APPROVAL에서 정지해야 한다.
      const settlementTransitionCall = transitionProposalMock.mock.calls.find(
        (call) => call[0] === "proposal-settlement-x"
      );
      expect(settlementTransitionCall?.[1]).toBe("PENDING_APPROVAL");

      // executeWriteAction은 settlement에 대해서는 호출되지 않는다(수동 경로).
      for (const call of executeWriteActionMock.mock.calls) {
        expect(call[0]).not.toBe("confirm_settlement");
      }

      // actionProposalId는 첫 번째로 생성된 기안(memo)의 ID를 반영한다(기존 하위호환 규약).
      expect(body.actionProposalId).toBe("proposal-memo-x");
    });

    it("자동실행 중 executeWriteAction이 throw하면 APPROVED→FAILED로 전이하고 응답은 정상(m4 격리)이다", async () => {
      runAgentMock.mockResolvedValue(memoIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-memo-fail" });

      transitionProposalMock.mockImplementation(
        async (id: string, toStatus: string, _opts: Record<string, unknown>) => {
          return { id, status: toStatus };
        }
      );
      transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(fakeTx));
      executeWriteActionMock.mockRejectedValue(new Error("실행 중 오류(테스트 유도)"));

      const res = await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("메모를 기록했습니다.");

      // FAILED 전이가 별도로 호출되어야 한다(APPROVED→FAILED, tx 없이 독립 트랜잭션).
      const failedCall = transitionProposalMock.mock.calls.find((call) => call[1] === "FAILED");
      expect(failedCall).toBeDefined();
      expect(failedCall?.[0]).toBe("proposal-memo-fail");
      expect(failedCall?.[2]).toEqual(
        expect.objectContaining({ expectedFrom: "APPROVED" })
      );
      const failedData = (failedCall?.[2] as Record<string, unknown>)?.data as Record<string, unknown>;
      expect(failedData?.errorMessage).toBeDefined();
    });

    it("자동실행이 커밋되면 승인 버튼 경로와 같은 후속 처리(캐시 무효화·캘린더)를 호출한다", async () => {
      runAgentMock.mockResolvedValue(memoIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-memo-effects" });
      transitionProposalMock.mockImplementation(async (id: string, toStatus: string) => ({
        id,
        status: toStatus,
      }));
      setupSuccessfulTransaction();
      const execResult = { refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" };
      executeWriteActionMock.mockResolvedValue(execResult);

      await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));

      expect(applyWriteActionEffectsMock).toHaveBeenCalledTimes(1);
      expect(applyWriteActionEffectsMock).toHaveBeenCalledWith("add_entity_memo", execResult);
    });

    it("자동실행이 롤백되면 후속 처리를 호출하지 않는다 — 반영되지 않은 쓰기로 캐시를 깨지 않는다", async () => {
      runAgentMock.mockResolvedValue(memoIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-memo-rollback" });
      transitionProposalMock.mockImplementation(async (id: string, toStatus: string) => ({
        id,
        status: toStatus,
      }));
      setupSuccessfulTransaction();
      executeWriteActionMock.mockRejectedValue(new Error("실행 중 오류(테스트 유도)"));

      await POST(makeRequest({ message: "deal-1에 메모 남겨줘", history: [] }));

      expect(applyWriteActionEffectsMock).not.toHaveBeenCalled();
    });

    it("수동 승인 대기(alwaysManual)에서 정지한 기안은 후속 처리를 호출하지 않는다", async () => {
      runAgentMock.mockResolvedValue(settlementIntentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-settlement-manual" });
      transitionProposalMock.mockImplementation(async (id: string, toStatus: string) => ({
        id,
        status: toStatus,
      }));

      await POST(makeRequest({ message: "camp-1 입금확정해줘", history: [] }));

      expect(applyWriteActionEffectsMock).not.toHaveBeenCalled();
    });
  });

  // 어시스턴트 채팅 영속화 (Phase 5 청사진 v2 §2-1, §5)
  describe("어시스턴트 채팅 영속화 (§2-1)", () => {
    it("conversationId 없이 요청하면 새 대화를 생성(title=메시지 앞 80자)하고 응답에 conversationId를 포함한다", async () => {
      runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], writeIntents: [] }));
      createConversationMock.mockResolvedValue({ id: "conv-new-1" });

      const longMessage = "가".repeat(100);
      const res = await POST(makeRequest({ message: longMessage, history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(createConversationMock).toHaveBeenCalledTimes(1);
      const createArgs = createConversationMock.mock.calls[0][0];
      expect(createArgs.createdBy).toBe("user-1");
      expect(createArgs.title).toBe(longMessage.slice(0, 80));
      expect(body.conversationId).toBe("conv-new-1");
    });

    it("타인의 conversationId를 지정하면 404를 반환하고 runAgent는 호출되지 않는다(선행 하드 게이트, 무부작용)", async () => {
      findWithMessagesMock.mockResolvedValue({
        id: "conv-other",
        createdBy: "other-user",
        title: "제목",
        messages: [],
      });

      const res = await POST(
        makeRequest({ message: "질문", history: [], conversationId: "conv-other" })
      );

      expect(res.status).toBe(404);
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(createProposalMock).not.toHaveBeenCalled();
      expect(executeWriteActionMock).not.toHaveBeenCalled();
      expect(appendTurnsMock).not.toHaveBeenCalled();
    });

    it("존재하지 않는 conversationId를 지정해도 404를 반환하고 runAgent는 호출되지 않는다(존재 비노출과 동일 응답)", async () => {
      findWithMessagesMock.mockResolvedValue(null);

      const res = await POST(
        makeRequest({ message: "질문", history: [], conversationId: "conv-none" })
      );

      expect(res.status).toBe(404);
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it("본인 소유 conversationId를 지정하면 신규 생성 없이 그 대화에 이어서 저장한다", async () => {
      findWithMessagesMock.mockResolvedValue({
        id: "conv-mine",
        createdBy: "user-1",
        title: "기존 대화",
        messages: [],
      });
      runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], writeIntents: [] }));

      const res = await POST(
        makeRequest({ message: "이어지는 질문", history: [], conversationId: "conv-mine" })
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(body.conversationId).toBe("conv-mine");
      expect(appendTurnsMock).toHaveBeenCalledTimes(1);
      expect(appendTurnsMock.mock.calls[0][0]).toBe("conv-mine");
    });

    it("m4 격리: 영속화(appendTurns) 실패해도 채팅 응답은 정상이고 conversationId=null을 반환한다", async () => {
      runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], writeIntents: [] }));
      createConversationMock.mockResolvedValue({ id: "conv-fail-1" });
      appendTurnsMock.mockRejectedValue(new Error("DB 오류(테스트 유도)"));

      const res = await POST(makeRequest({ message: "질문", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("이번 달 정산 요약입니다.");
      expect(body.conversationId).toBeNull();
    });

    it("m4 격리: 대화 생성(create) 자체가 실패해도 채팅 응답은 정상이고 conversationId=null을 반환한다", async () => {
      runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], writeIntents: [] }));
      createConversationMock.mockRejectedValue(new Error("DB 연결 실패(테스트 유도)"));

      const res = await POST(makeRequest({ message: "질문", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reply).toBe("이번 달 정산 요약입니다.");
      expect(body.conversationId).toBeNull();
      expect(appendTurnsMock).not.toHaveBeenCalled();
    });

    it("user 턴과 model 턴 두 개가 저장되고, toolCalls·actionProposalIds가 함께 전달된다", async () => {
      runAgentMock.mockResolvedValue(agentResult());
      createProposalMock.mockResolvedValue({ id: "proposal-1" });
      transitionProposalMock.mockResolvedValue({ id: "proposal-1" });
      createConversationMock.mockResolvedValue({ id: "conv-new-2" });

      const res = await POST(makeRequest({ message: "이번 달 정산 알려줘", history: [] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(appendTurnsMock).toHaveBeenCalledTimes(1);
      const [convId, turns] = appendTurnsMock.mock.calls[0];
      expect(convId).toBe("conv-new-2");
      expect(turns.userText).toBe("이번 달 정산 알려줘");
      expect(turns.modelText).toBe("이번 달 정산 요약입니다.");
      expect(Array.isArray(turns.toolCalls)).toBe(true);
      expect(turns.toolCalls).toHaveLength(1);
      expect(Array.isArray(turns.actionProposalIds)).toBe(true);
      expect(turns.actionProposalIds).toContain("proposal-1");

      // 응답 필드 — 복수 actionProposalIds 추가, 단수 actionProposalId 하위호환 유지.
      expect(body.actionProposalId).toBe("proposal-1");
      expect(body.actionProposalIds).toEqual(["proposal-1"]);
    });

    it("에이전트 레인(userId===getAgentLaneUserId 반환값)이면 conversationId를 수용하지 않고 영속화를 전부 스킵한다(저장 0건)", async () => {
      getUserMock.mockResolvedValue({ data: { user: null } });
      getAgentLaneUserIdMock.mockReturnValue("agent-preview");
      runAgentMock.mockResolvedValue(agentResult({ toolCalls: [], writeIntents: [] }));

      const res = await POST(
        makeRequest({ message: "레인 질문", history: [], conversationId: "conv-should-be-ignored" })
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      // 레인 호출은 소유 검증도, 신규 생성도, 메시지 저장도 전혀 하지 않는다.
      expect(findWithMessagesMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(appendTurnsMock).not.toHaveBeenCalled();
      expect(body.conversationId).toBeNull();
    });
  });
});
