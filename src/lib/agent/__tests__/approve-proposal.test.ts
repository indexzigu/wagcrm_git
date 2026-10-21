/**
 * approveProposal · bulkApproveProposals — 승인+실행 SSOT (단건·일괄 라우트 공용).
 *
 * 단건 라우트의 HTTP 계약은 `src/app/api/action-proposals/[id]/approve/route.test.ts` 가 그대로
 * 고정한다(이 함수로 옮기기 전 테스트를 고치지 않고 통과). 여기서는 판정(code·status)과
 * 일괄 순회의 성질(순서 · 한 건 실패가 나머지를 멈추지 않음 · 분류)을 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findByIdMock = vi.fn();
const transitionMock = vi.fn();
const executeWriteActionMock = vi.fn();
const transactionMock = vi.fn();
const applyWriteActionEffectsMock = vi.fn();

class FakeConcurrentModificationError extends Error {}

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    transition: (...args: unknown[]) => transitionMock(...args),
  },
  ConcurrentModificationError: FakeConcurrentModificationError,
}));

vi.mock("@/lib/agent/write-executor", () => ({
  executeWriteAction: (...args: unknown[]) => executeWriteActionMock(...args),
}));

vi.mock("@/lib/agent/write-action-effects", () => ({
  applyWriteActionEffects: (...args: unknown[]) => applyWriteActionEffectsMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: transactionMock }),
}));

// [캘린더수집] 승인 뒤 넘겨받기 — 장부 기록과 수집 행 상태 표기는 가짜로, 출처 읽기(`readCalendarInboundRef`)는 진짜로.
const callOrder: string[] = [];
const adoptCalendarEventIntoLedgerMock = vi.fn();
const markInboundAdoptedMock = vi.fn();
const resetInboundForRetryMock = vi.fn();

vi.mock("@/lib/google-calendar-sync", () => ({
  adoptCalendarEventIntoLedger: (...args: unknown[]) => adoptCalendarEventIntoLedgerMock(...args),
}));

vi.mock("@/lib/calendar-inbound/adopt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-inbound/adopt")>();
  return {
    ...actual,
    markInboundAdopted: (...args: unknown[]) => markInboundAdoptedMock(...args),
    resetInboundForRetry: (...args: unknown[]) => resetInboundForRetryMock(...args),
  };
});

const { approveProposal, bulkApproveProposals } = await import("../approve-proposal");

const APPROVER = "owner@example.com";

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    createdBy: "AGENT_WORKER",
    payload: { action: "add_entity_memo", args: { entityType: "DEAL", entityId: "deal-1", content: "메모" } },
    ...overrides,
  };
}

const EXEC_RESULT = { refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" };

beforeEach(() => {
  findByIdMock.mockReset();
  transitionMock.mockReset();
  executeWriteActionMock.mockReset();
  transactionMock.mockReset();
  applyWriteActionEffectsMock.mockReset();
  callOrder.length = 0;
  adoptCalendarEventIntoLedgerMock.mockReset();
  markInboundAdoptedMock.mockReset();
  resetInboundForRetryMock.mockReset();
  adoptCalendarEventIntoLedgerMock.mockImplementation(async () => {
    callOrder.push("ledger");
    return "adopted";
  });
  markInboundAdoptedMock.mockImplementation(async () => {
    callOrder.push("mark");
  });
  resetInboundForRetryMock.mockResolvedValue(undefined);
  applyWriteActionEffectsMock.mockImplementation(() => {
    callOrder.push("effects");
  });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("approveProposal", () => {
  it("성공: tx1 CAS(PENDING_APPROVAL→APPROVED) → tx2 실행+EXECUTED → 후속 처리", async () => {
    findByIdMock.mockResolvedValue(makeProposal());
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue(EXEC_RESULT);

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: true, action: "add_entity_memo", result: EXEC_RESULT });
    expect(transitionMock.mock.calls[0][1]).toBe("APPROVED");
    expect(transitionMock.mock.calls[0][2]).toMatchObject({ expectedFrom: "PENDING_APPROVAL", actor: APPROVER });
    expect(transitionMock.mock.calls[1][1]).toBe("EXECUTED");
    expect(transitionMock.mock.calls[1][2]).toMatchObject({ expectedFrom: "APPROVED" });
    expect(applyWriteActionEffectsMock).toHaveBeenCalledWith("add_entity_memo", EXEC_RESULT);
  });

  it("expectedStatus:PENDING_APPROVAL 이면 FAILED 기안을 재시도하지 않는다(자동 실행기 전용 문)", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ status: "FAILED" }));

    const outcome = await approveProposal("p1", "SYSTEM_AUTO", { expectedStatus: "PENDING_APPROVAL" });

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATUS", status: "FAILED" });
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("문자열로 저장된 payload(SQLite 레인)도 읽어 실행한다", async () => {
    findByIdMock.mockResolvedValue(
      makeProposal({ payload: JSON.stringify({ action: "add_entity_memo", args: { entityType: "DEAL" } }) }),
    );
    transitionMock.mockResolvedValue({ id: "p1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue(EXEC_RESULT);

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: true, action: "add_entity_memo" });
    expect(executeWriteActionMock.mock.calls[0][0]).toBe("add_entity_memo");
  });

  it("self-approval(기안자===승인자)은 거부하고 어떤 전이도 하지 않는다", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ createdBy: APPROVER }));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: false, code: "SELF_APPROVAL", httpStatus: 403 });
    expect(transitionMock).not.toHaveBeenCalled();
    expect(executeWriteActionMock).not.toHaveBeenCalled();
  });

  it("CAS 충돌(다른 요청이 먼저 승인)이면 CONFLICT 이고 실행하지 않는다", async () => {
    findByIdMock.mockResolvedValue(makeProposal());
    transitionMock.mockRejectedValueOnce(new FakeConcurrentModificationError("선점 실패"));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: false, code: "CONFLICT", httpStatus: 409 });
    expect(executeWriteActionMock).not.toHaveBeenCalled();
    expect(applyWriteActionEffectsMock).not.toHaveBeenCalled();
  });

  it("tx2 실행 실패면 APPROVED→FAILED 를 기록하고 EXECUTION_FAILED 로 돌려준다(던지지 않는다)", async () => {
    findByIdMock.mockResolvedValue(makeProposal());
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "FAILED" });
    executeWriteActionMock.mockRejectedValue(new Error("대상 딜을 찾을 수 없습니다"));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      httpStatus: 502,
      status: "FAILED",
      error: "실행 실패: 대상 딜을 찾을 수 없습니다",
    });
    const failedCall = transitionMock.mock.calls.find((call) => call[1] === "FAILED");
    expect(failedCall?.[2]).toMatchObject({ data: { errorMessage: "대상 딜을 찾을 수 없습니다" } });
    expect(applyWriteActionEffectsMock).not.toHaveBeenCalled();
  });

  it("FAILED 기안은 재시도로 승인한다(expectedFrom=FAILED)", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ status: "FAILED" }));
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue(EXEC_RESULT);

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome.ok).toBe(true);
    expect(transitionMock.mock.calls[0][2]).toMatchObject({ expectedFrom: "FAILED", note: "재시도 승인" });
  });

  it("승인 대기·실패가 아닌 상태(EXECUTED)는 INVALID_STATUS 이고 전이하지 않는다", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ status: "EXECUTED" }));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATUS", status: "EXECUTED" });
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("없는 기안은 NOT_FOUND", async () => {
    findByIdMock.mockResolvedValue(null);
    await expect(approveProposal("nope", APPROVER)).resolves.toMatchObject({ ok: false, code: "NOT_FOUND", status: null });
  });

  it("payload 가 비어 있으면 승인 뒤 FAILED 로 기록하고 EMPTY_PAYLOAD", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ payload: null }));
    transitionMock.mockResolvedValue({});

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: false, code: "EMPTY_PAYLOAD", httpStatus: 422, status: "FAILED" });
    expect(transitionMock.mock.calls.map((call) => call[1])).toEqual(["APPROVED", "FAILED"]);
    expect(executeWriteActionMock).not.toHaveBeenCalled();
  });
});

const INBOUND_REF = {
  inboundId: "in-1",
  eventId: "ev-owner",
  calendarId: "primary",
  ledgerKind: "campaign",
  adopt: true,
  summary: "샘플셀러 테스트브랜드 2차",
  startDate: "2026-11-03",
  endDate: "2026-11-09",
  htmlLink: null,
  warnings: [],
};

function inboundCreateProposal(refOverrides: Record<string, unknown> = {}, asString = false) {
  const sourceRef = { calendarInbound: { ...INBOUND_REF, ...refOverrides } };
  return makeProposal({
    createdBy: "SYSTEM_CALENDAR_INBOUND",
    payload: {
      action: "create_campaign_round",
      args: { dealId: "deal-1", sellerId: "seller-1", startDate: "2026-11-03", endDate: "2026-11-09" },
    },
    sourceRef: asString ? JSON.stringify(sourceRef) : sourceRef,
  });
}

const CREATE_RESULT = { refType: "CAMPAIGN", refId: "camp-new", summary: "회차 생성" };

describe("approveProposal — [캘린더수집] 넘겨받기", () => {
  function primeExecuted(result = CREATE_RESULT) {
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue(result);
  }

  it("새 회차: 커밋 뒤 장부 넘겨받기 → ADOPTED 표기 → 그다음 후속 처리(동기화가 원본을 제자리 갱신)", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    primeExecuted();

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome.ok).toBe(true);
    expect(adoptCalendarEventIntoLedgerMock).toHaveBeenCalledWith({
      campaignId: "camp-new",
      kind: "campaign",
      eventId: "ev-owner",
      calendarId: "primary",
    });
    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-new", { skipReason: null });
    expect(callOrder).toEqual(["ledger", "mark", "effects"]);
  });

  it("기록 수정 기안은 기안이 가리킨 캠페인(args.entityId)에 넘겨받는다 · 문자열 sourceRef(SQLite)도 읽는다", async () => {
    findByIdMock.mockResolvedValue(
      makeProposal({
        createdBy: "SYSTEM_CALENDAR_INBOUND",
        payload: {
          action: "update_record",
          args: { entityType: "CAMPAIGN", entityId: "camp-old", changes: {}, expected: {} },
        },
        sourceRef: JSON.stringify({ calendarInbound: { ...INBOUND_REF, ledgerKind: "deposit" } }),
      }),
    );
    primeExecuted({ refType: "CAMPAIGN", refId: "camp-old", summary: "수정" });

    await approveProposal("p1", APPROVER);

    expect(adoptCalendarEventIntoLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "camp-old", kind: "deposit" }),
    );
    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-old", { skipReason: null });
  });

  it("adopt:false 면 장부는 건드리지 않고 ADOPTED 로만 표기한다(멱등 제외)", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal({ adopt: false }));
    primeExecuted();

    await approveProposal("p1", APPROVER);

    expect(adoptCalendarEventIntoLedgerMock).not.toHaveBeenCalled();
    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-new", { skipReason: null });
    expect(applyWriteActionEffectsMock).toHaveBeenCalled();
  });

  it("장부 키 충돌이면 ADOPTED + skipReason ledger_conflict(다시 기안하지 않는다)", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    primeExecuted();
    adoptCalendarEventIntoLedgerMock.mockResolvedValue("conflict");

    await approveProposal("p1", APPROVER);

    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-new", { skipReason: "ledger_conflict" });
  });

  it("넘겨받기가 던져도 승인은 성공이고 후속 처리는 돈다(쓰기는 이미 커밋됨)", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    primeExecuted();
    adoptCalendarEventIntoLedgerMock.mockRejectedValue(new Error("DB 끊김"));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome.ok).toBe(true);
    expect(applyWriteActionEffectsMock).toHaveBeenCalledWith("create_campaign_round", CREATE_RESULT);
    expect(console.error).toHaveBeenCalled();
    // 그래도 처리 끝으로 적는다 — 같은 일정을 다시 기안하지 않게.
    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-new", { skipReason: "adopt_failed" });
  });

  it("넘겨받기와 처리 끝 표기가 둘 다 던져도 승인은 성공이고 둘 다 보고한다", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    primeExecuted();
    adoptCalendarEventIntoLedgerMock.mockRejectedValue(new Error("DB 끊김"));
    markInboundAdoptedMock.mockRejectedValue(new Error("DB 끊김 2"));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome.ok).toBe(true);
    expect(applyWriteActionEffectsMock).toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["already_referenced", "already_referenced"],
    ["not_active", "not_active"],
    ["conflict", "ledger_conflict"],
    ["already_adopted", null],
  ] as const)("넘겨받기 판정 %s → 처리 끝 사유 %s", async (adopted, skipReason) => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    primeExecuted();
    adoptCalendarEventIntoLedgerMock.mockResolvedValue(adopted);

    await approveProposal("p1", APPROVER);

    expect(markInboundAdoptedMock).toHaveBeenCalledWith("in-1", "camp-new", { skipReason });
  });

  it("실행이 FAILED 로 끝나면 수집 행을 재판정 대기로 되돌린다", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "FAILED" });
    executeWriteActionMock.mockRejectedValue(new Error("지금 값이 기안 때와 다릅니다"));

    const outcome = await approveProposal("p1", APPROVER);

    expect(outcome).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
    expect(resetInboundForRetryMock).toHaveBeenCalledWith("in-1");
    expect(adoptCalendarEventIntoLedgerMock).not.toHaveBeenCalled();
    expect(markInboundAdoptedMock).not.toHaveBeenCalled();
  });

  it("되돌리기가 던져도 판정(EXECUTION_FAILED)은 그대로 돌려준다", async () => {
    findByIdMock.mockResolvedValue(inboundCreateProposal());
    transitionMock
      .mockResolvedValueOnce({ id: "p1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "p1", status: "FAILED" });
    executeWriteActionMock.mockRejectedValue(new Error("x"));
    resetInboundForRetryMock.mockRejectedValue(new Error("DB 끊김"));

    await expect(approveProposal("p1", APPROVER)).resolves.toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
  });

  it("캘린더 출처가 없는 기안은 넘겨받기·되돌리기를 하지 않는다", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ sourceRef: { workRecordId: "w1" } }));
    primeExecuted(EXEC_RESULT);

    await approveProposal("p1", APPROVER);

    expect(adoptCalendarEventIntoLedgerMock).not.toHaveBeenCalled();
    expect(markInboundAdoptedMock).not.toHaveBeenCalled();
    expect(resetInboundForRetryMock).not.toHaveBeenCalled();
  });
});

describe("bulkApproveProposals", () => {
  it("주어진 순서대로 한 건씩 처리하고, 중간 실패가 나머지를 멈추지 않는다", async () => {
    const proposals: Record<string, ReturnType<typeof makeProposal>> = {
      a: makeProposal({ id: "a" }),
      b: makeProposal({ id: "b", payload: { action: "create_partner", args: { name: "x" } } }),
      c: makeProposal({ id: "c" }),
    };
    findByIdMock.mockImplementation(async (id: string) => proposals[id] ?? null);
    transitionMock.mockImplementation(async (id: string, to: string) => ({ id, status: to }));
    executeWriteActionMock.mockImplementation(async (action: string) => {
      if (action === "create_partner") throw new Error("중복 거래처");
      return EXEC_RESULT;
    });

    const response = await bulkApproveProposals(["c", "b", "a"], APPROVER);

    // 순서: 결과도, 실행 호출도 요청 순서 그대로다.
    expect(response.results.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(findByIdMock.mock.calls.map((call) => call[0])).toEqual(["c", "b", "a"]);
    expect(response.results).toEqual([
      { id: "c", ok: true, outcome: "executed", status: "EXECUTED" },
      { id: "b", ok: false, outcome: "failed", status: "FAILED", error: "실행 실패: 중복 거래처" },
      { id: "a", ok: true, outcome: "executed", status: "EXECUTED" },
    ]);
    expect(response.counts).toEqual({ total: 3, executed: 2, failed: 1, skipped: 0 });
    // b 의 실패는 FAILED 로 기록됐다(재시도 가능 상태).
    expect(transitionMock.mock.calls.some((call) => call[0] === "b" && call[1] === "FAILED")).toBe(true);
  });

  it("승인 대기가 아닌 기안·CAS 충돌은 건너뜀, 없는 기안은 실패로 센다", async () => {
    findByIdMock.mockImplementation(async (id: string) => {
      if (id === "done") return makeProposal({ id, status: "EXECUTED" });
      if (id === "rejected") return makeProposal({ id, status: "REJECTED" });
      if (id === "raced") return makeProposal({ id });
      return null;
    });
    transitionMock.mockRejectedValueOnce(new FakeConcurrentModificationError("선점 실패"));

    const response = await bulkApproveProposals(["done", "rejected", "missing", "raced"], APPROVER);

    expect(response.results.map((item) => item.outcome)).toEqual(["skipped", "skipped", "failed", "skipped"]);
    expect(response.results.every((item) => item.ok === false && typeof item.error === "string")).toBe(true);
    // 결과 창에 상태 식별자(EXECUTED)를 그대로 내보내지 않는다.
    expect(response.results[0].error).toBe("승인 대기 상태가 아닙니다 (현재: 완료).");
    expect(response.results[3].error).toBe("이미 다른 곳에서 처리된 기안입니다.");
    expect(response.counts).toEqual({ total: 4, executed: 0, failed: 1, skipped: 3 });
    expect(response.results[2].error).toMatch(/찾을 수 없습니다/);
    expect(executeWriteActionMock).not.toHaveBeenCalled();
  });

  it("self-approval 거부는 실패로 센다 — 운영자가 알아야 하는 정책 거부다", async () => {
    findByIdMock.mockResolvedValue(makeProposal({ createdBy: APPROVER }));

    const response = await bulkApproveProposals(["p1"], APPROVER);

    expect(response.results[0]).toMatchObject({ outcome: "failed", ok: false });
    expect(response.results[0].error).toBe("본인이 올린 기안은 본인이 승인할 수 없습니다.");
  });

  it("한 건이 예외를 던지면 상태를 다시 읽어 판정하고 다음 건을 계속한다", async () => {
    // x: 커밋 뒤 후속 처리가 던짐(실행은 됨) · y: 정상
    const state: Record<string, string> = { x: "PENDING_APPROVAL", y: "PENDING_APPROVAL" };
    findByIdMock.mockImplementation(async (id: string) => makeProposal({ id, status: state[id] }));
    transitionMock.mockImplementation(async (id: string, to: string) => {
      state[id] = to;
      return { id, status: to };
    });
    executeWriteActionMock.mockResolvedValue(EXEC_RESULT);
    applyWriteActionEffectsMock.mockImplementationOnce(() => {
      throw new Error("캐시 무효화 폭발");
    });

    const response = await bulkApproveProposals(["x", "y"], APPROVER);

    expect(response.results[0]).toMatchObject({ id: "x", ok: true, outcome: "executed", status: "EXECUTED" });
    expect(response.results[0].error).toMatch(/후속 처리/);
    expect(response.results[1]).toEqual({ id: "y", ok: true, outcome: "executed", status: "EXECUTED" });
  });

  it("상한(50건)을 넘기면 아무것도 처리하지 않고 던진다(라우트 검증의 이중 방어)", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `id-${index}`);
    await expect(bulkApproveProposals(ids, APPROVER)).rejects.toThrow(/50/);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
