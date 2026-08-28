/**
 * POST /api/action-proposals/[id]/approve — 승인+실행 (청사진 §0-4/§0-5/§0-7).
 *
 * 시나리오:
 * ① requireRole("admin") 미통과 → 403
 * ② self-approval(createdBy===userId) → 403, 어떤 전이도 없음
 * ③ 정상: tx1 PENDING_APPROVAL→APPROVED(조건부) → tx2 executeWriteAction+APPROVED→EXECUTED 원자
 * ④ 동시 승인: tx1 conditional count=0 → 409, 실행 안 됨
 * ⑤ 실행 실패(엔티티 부재 등) → APPROVED→FAILED + errorMessage, tx2 롤백
 * ⑥ FAILED에서 재시도 가능 (expectedFrom=FAILED 허용 여부는 라우트가 현재 상태를 보고 판단)
 * ⑦ 커밋 뒤 후속 처리(캐시 무효화·캘린더 재동기화)가 성공 실행에만, 실패 분류 밖에서 돈다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireRoleMock = vi.fn();
const findByIdMock = vi.fn();
const transitionMock = vi.fn();
const executeWriteActionMock = vi.fn();
const getPrismaMock = vi.fn();
const transactionMock = vi.fn();
const applyWriteActionEffectsMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

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
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

const { POST } = await import("./route");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest() {
  return new NextRequest("http://localhost/api/action-proposals/proposal-1/approve", { method: "POST" });
}

const baseProposal = {
  id: "proposal-1",
  status: "PENDING_APPROVAL",
  kind: "WRITE",
  createdBy: "creator@example.com",
  payload: { action: "add_entity_memo", args: { entityType: "DEAL", entityId: "deal-1", content: "메모" } },
  targetEntityType: "DEAL",
  targetEntityId: "deal-1",
};

describe("POST /api/action-proposals/[id]/approve", () => {
  beforeEach(() => {
    requireRoleMock.mockReset();
    findByIdMock.mockReset();
    transitionMock.mockReset();
    executeWriteActionMock.mockReset();
    getPrismaMock.mockReset();
    transactionMock.mockReset();
    applyWriteActionEffectsMock.mockReset();

    requireRoleMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "approver@example.com", role: "admin" },
    });
    getPrismaMock.mockReturnValue({ $transaction: transactionMock });
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  it("admin이 아니면 403을 반환하고 어떤 전이도 없다", async () => {
    requireRoleMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(403);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("self-approval(기안자===승인자) 시 403을 반환하고 전이하지 않는다 (§0-7)", async () => {
    requireRoleMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "creator@example.com", role: "admin" },
    });
    findByIdMock.mockResolvedValue(baseProposal);

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/본인|self|자기/i);
    expect(transitionMock).not.toHaveBeenCalled();
    expect(executeWriteActionMock).not.toHaveBeenCalled();
  });

  it("존재하지 않는 기안이면 404를 반환한다", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeParams("proposal-x"));
    expect(res.status).toBe(404);
  });

  it("정상 승인: PENDING_APPROVAL→APPROVED(조건부) 후 실행+EXECUTED가 성공한다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" }) // tx1
      .mockResolvedValueOnce({ id: "proposal-1", status: "EXECUTED" }); // tx2 내부
    executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.proposal.status).toBe("EXECUTED");

    // tx1: PENDING_APPROVAL -> APPROVED, expectedFrom 지정.
    const tx1Args = transitionMock.mock.calls[0];
    expect(tx1Args[1]).toBe("APPROVED");
    expect(tx1Args[2]).toMatchObject({ expectedFrom: "PENDING_APPROVAL" });

    // tx2: executeWriteAction과 EXECUTED 전이가 같은 $transaction 콜백 안에서 실행.
    expect(executeWriteActionMock).toHaveBeenCalledWith(
      "add_entity_memo",
      { entityType: "DEAL", entityId: "deal-1", content: "메모" },
      "approver@example.com",
      expect.anything()
    );
    const tx2Args = transitionMock.mock.calls[1];
    expect(tx2Args[1]).toBe("EXECUTED");
  });

  it("m3 [Minor, 방어심층]: tx2의 APPROVED→EXECUTED 전이에도 expectedFrom:'APPROVED'가 지정된다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "proposal-1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" });

    await POST(makeRequest(), makeParams("proposal-1"));

    const tx2Args = transitionMock.mock.calls[1];
    expect(tx2Args[1]).toBe("EXECUTED");
    expect(tx2Args[2]).toMatchObject({ expectedFrom: "APPROVED" });
  });

  it("동시 승인(tx1 count=0/ConcurrentModificationError)이면 409를 반환하고 실행하지 않는다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock.mockRejectedValueOnce(new FakeConcurrentModificationError("이미 처리됨"));

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(409);
    expect(executeWriteActionMock).not.toHaveBeenCalled();
  });

  it("실행 실패(엔티티 부재 등) 시 APPROVED→FAILED로 기록하고 502/422를 반환한다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    // tx1(APPROVED) 성공, executeWriteAction이 tx2 콜백 안에서 throw -> $transaction reject
    // -> 그 뒤 별도 트랜잭션으로 APPROVED->FAILED 기록(3번째 transition 호출)은 정상 성공.
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" }) // tx1
      .mockResolvedValueOnce({ id: "proposal-1", status: "FAILED" }); // FAILED 기록
    executeWriteActionMock.mockRejectedValue(new Error("대상 딜(deal-1)를 찾을 수 없습니다"));

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    const body = await res.json();

    expect([409, 422, 502]).toContain(res.status);
    expect(body.error).toBeTruthy();

    // FAILED 기록 전이가 호출되었는지 확인 (tx1 APPROVED 이후, 별도 트랜잭션으로 FAILED).
    const failedCall = transitionMock.mock.calls.find((call) => call[1] === "FAILED");
    expect(failedCall).toBeTruthy();
  });

  it("FAILED 상태에서 재시도 승인 시 APPROVED로 재전이(expectedFrom=FAILED)한다", async () => {
    findByIdMock.mockResolvedValue({ ...baseProposal, status: "FAILED" });
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "proposal-1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(200);

    const tx1Args = transitionMock.mock.calls[0];
    expect(tx1Args[2]).toMatchObject({ expectedFrom: "FAILED" });
  });

  it("PENDING_APPROVAL도 FAILED도 아닌 상태(예: EXECUTED)에서는 409를 반환하고 아무 전이도 하지 않는다", async () => {
    findByIdMock.mockResolvedValue({ ...baseProposal, status: "EXECUTED" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(409);
    expect(transitionMock).not.toHaveBeenCalled();
  });
  it("정상 실행이면 커밋 뒤 후속 처리(캐시 무효화·캘린더)를 실행 결과와 함께 호출한다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "proposal-1", status: "EXECUTED" });
    const execResult = { refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" };
    executeWriteActionMock.mockResolvedValue(execResult);

    const res = await POST(makeRequest(), makeParams("proposal-1"));

    expect(res.status).toBe(200);
    expect(applyWriteActionEffectsMock).toHaveBeenCalledTimes(1);
    expect(applyWriteActionEffectsMock).toHaveBeenCalledWith("add_entity_memo", execResult);
  });

  it("실행이 롤백되면(FAILED) 후속 처리를 하지 않는다 — 반영되지 않은 쓰기로 캐시를 깨지 않는다", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "proposal-1", status: "FAILED" });
    executeWriteActionMock.mockRejectedValue(new Error("대상 딜(deal-1)를 찾을 수 없습니다"));

    await POST(makeRequest(), makeParams("proposal-1"));

    expect(applyWriteActionEffectsMock).not.toHaveBeenCalled();
  });

  it("후속 처리가 터져도 성공한 실행을 FAILED로 되돌리지 않는다 (실패 분류 try 밖 배치 고정)", async () => {
    findByIdMock.mockResolvedValue(baseProposal);
    transitionMock
      .mockResolvedValueOnce({ id: "proposal-1", status: "APPROVED" })
      .mockResolvedValueOnce({ id: "proposal-1", status: "EXECUTED" });
    executeWriteActionMock.mockResolvedValue({ refType: "DEAL", refId: "deal-1", summary: "메모 기록됨" });
    applyWriteActionEffectsMock.mockImplementation(() => {
      throw new Error("후속 처리 폭발");
    });

    await expect(POST(makeRequest(), makeParams("proposal-1"))).rejects.toThrow("후속 처리 폭발");

    // 실제 applyWriteActionEffects는 던지지 않도록 만들어져 있지만, 이 테스트가 고정하는 것은
    // **배치**다 — 저 호출이 tx2 try 안에 있었다면 여기서 FAILED 전이가 잡혔을 것이다.
    expect(transitionMock.mock.calls.some((call) => call[1] === "FAILED")).toBe(false);
  });
});
