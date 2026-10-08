/**
 * POST /api/action-proposals/bulk-approve — 기안 일괄 승인+실행.
 *
 * 저장소는 **상태를 기억하는 가짜**로 둔다(조건부 전이 = CAS 흉내). 그래야 「같은 목록을 두 번
 * 보내도 두 번 실행되지 않는다」를 호출 횟수가 아니라 실제 상태 변화로 확인할 수 있다.
 *
 * ① 인가: admin 이 아니면 403, 아무것도 읽지 않는다
 * ② 검증: JSON 아님 · ids 없음/배열 아님 · 0건 · 51건 · 중복 · 빈 id → 400, 아무것도 처리 안 함
 * ③ 부분 실패: 가운데 한 건이 실패해도 앞뒤는 실행되고 200 + 건별 결과·집계
 * ④ 순서: 요청한 순서대로 실행된다
 * ⑤ 멱등: 같은 목록을 두 번 보내면 두 번째는 전부 건너뜀이고 실행 횟수가 늘지 않는다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireRoleMock = vi.fn();
const executeWriteActionMock = vi.fn();
const applyWriteActionEffectsMock = vi.fn();

class FakeConcurrentModificationError extends Error {}

type FakeProposal = {
  id: string;
  status: string;
  createdBy: string;
  payload: { action: string; args: Record<string, unknown> } | null;
};

const store = new Map<string, FakeProposal>();

vi.mock("@/lib/api-auth", () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findById: async (id: string) => {
      const row = store.get(id);
      return row ? { ...row } : null;
    },
    transition: async (
      id: string,
      to: string,
      options: { expectedFrom?: string } = {}
    ) => {
      const row = store.get(id);
      if (!row) throw new Error(`no proposal ${id}`);
      if (options.expectedFrom && row.status !== options.expectedFrom) {
        throw new FakeConcurrentModificationError(`${id} 선점 실패`);
      }
      row.status = to;
      return { ...row };
    },
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
  getPrisma: () => ({
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
  }),
}));

const { POST } = await import("./route");

function seed(id: string, overrides: Partial<FakeProposal> = {}) {
  store.set(id, {
    id,
    status: "PENDING_APPROVAL",
    createdBy: "AGENT_WORKER",
    payload: { action: "add_entity_memo", args: { entityType: "DEAL", entityId: `deal-${id}`, content: id } },
    ...overrides,
  });
}

function makeRequest(body: unknown, raw = false) {
  return new Request("http://localhost/api/action-proposals/bulk-approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** 실행기에 넘어간 순서 — args.content 에 기안 id 를 실어 두었다. */
function executedOrder(): string[] {
  return executeWriteActionMock.mock.calls.map((call) => (call[1] as { content: string }).content);
}

beforeEach(() => {
  store.clear();
  requireRoleMock.mockReset();
  executeWriteActionMock.mockReset();
  applyWriteActionEffectsMock.mockReset();
  requireRoleMock.mockResolvedValue({
    authenticated: true,
    context: { userId: "owner@example.com", role: "admin" },
  });
  executeWriteActionMock.mockImplementation(async (_action: string, args: { content: string }) => ({
    refType: "DEAL",
    refId: `deal-${args.content}`,
    summary: "메모 기록됨",
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/action-proposals/bulk-approve", () => {
  it("admin 이 아니면 403 이고 아무것도 처리하지 않는다", async () => {
    seed("a");
    requireRoleMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });

    const res = await POST(makeRequest({ ids: ["a"] }));

    expect(res.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith("admin");
    expect(executeWriteActionMock).not.toHaveBeenCalled();
    expect(store.get("a")?.status).toBe("PENDING_APPROVAL");
  });

  it.each([
    ["JSON 이 아닌 본문", "{not json", true],
    ["ids 없음", {}, false],
    ["ids 가 배열이 아님", { ids: "a" }, false],
    ["0건", { ids: [] }, false],
    ["51건(상한 50 초과)", { ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) }, false],
    ["중복 id", { ids: ["a", "b", "a"] }, false],
    ["빈 id", { ids: ["a", ""] }, false],
    ["문자열이 아닌 id", { ids: ["a", 7] }, false],
  ])("검증 실패(%s)는 400 이고 아무것도 처리하지 않는다", async (_label, body, raw) => {
    seed("a");
    seed("b");

    const res = await POST(makeRequest(body, raw));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(typeof json.error).toBe("string");
    expect(executeWriteActionMock).not.toHaveBeenCalled();
    expect(store.get("a")?.status).toBe("PENDING_APPROVAL");
  });

  it("50건은 상한 안이라 받는다", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `id-${index}`);
    ids.forEach((id) => seed(id));

    const res = await POST(makeRequest({ ids }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.counts).toEqual({ total: 50, executed: 50, failed: 0, skipped: 0 });
  });

  it("부분 실패: 가운데 한 건이 실패해도 나머지는 실행되고 200 + 건별 결과를 돌려준다", async () => {
    seed("a");
    seed("b");
    seed("c");
    executeWriteActionMock.mockImplementation(async (_action: string, args: { content: string }) => {
      if (args.content === "b") throw new Error("대상 딜을 찾을 수 없습니다");
      return { refType: "DEAL", refId: `deal-${args.content}`, summary: "메모 기록됨" };
    });

    const res = await POST(makeRequest({ ids: ["a", "b", "c"] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.results).toEqual([
      { id: "a", ok: true, outcome: "executed", status: "EXECUTED" },
      { id: "b", ok: false, outcome: "failed", status: "FAILED", error: "실행 실패: 대상 딜을 찾을 수 없습니다" },
      { id: "c", ok: true, outcome: "executed", status: "EXECUTED" },
    ]);
    expect(json.counts).toEqual({ total: 3, executed: 2, failed: 1, skipped: 0 });
    expect(store.get("b")?.status).toBe("FAILED");
    // 후속 처리는 실행이 커밋된 건에만 돈다.
    expect(applyWriteActionEffectsMock).toHaveBeenCalledTimes(2);
  });

  it("요청한 순서대로 한 건씩 실행한다", async () => {
    ["a", "b", "c", "d"].forEach((id) => seed(id));

    const res = await POST(makeRequest({ ids: ["d", "b", "a", "c"] }));
    const json = await res.json();

    expect(executedOrder()).toEqual(["d", "b", "a", "c"]);
    expect(json.results.map((item: { id: string }) => item.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("같은 목록을 두 번 보내면 두 번째는 전부 건너뜀이고 다시 실행하지 않는다(멱등)", async () => {
    seed("a");
    seed("b");

    const first = await (await POST(makeRequest({ ids: ["a", "b"] }))).json();
    const second = await (await POST(makeRequest({ ids: ["a", "b"] }))).json();

    expect(first.counts).toEqual({ total: 2, executed: 2, failed: 0, skipped: 0 });
    expect(second.counts).toEqual({ total: 2, executed: 0, failed: 0, skipped: 2 });
    expect(second.results.every((item: { status: string }) => item.status === "EXECUTED")).toBe(true);
    expect(executeWriteActionMock).toHaveBeenCalledTimes(2);
  });

  it("실패했던 기안은 재시도로 다시 실행된다(단건 승인 규칙과 같다)", async () => {
    seed("a", { status: "FAILED" });

    const json = await (await POST(makeRequest({ ids: ["a"] }))).json();

    expect(json.results[0]).toMatchObject({ outcome: "executed", status: "EXECUTED" });
  });

  it("승인 대기가 아닌 기안·없는 기안은 오류가 아니라 건너뜀이다", async () => {
    seed("done", { status: "EXECUTED" });
    seed("rejected", { status: "REJECTED" });
    seed("ok");

    const json = await (await POST(makeRequest({ ids: ["done", "missing", "rejected", "ok"] }))).json();

    expect(json.results.map((item: { outcome: string }) => item.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "executed",
    ]);
    expect(json.counts).toEqual({ total: 4, executed: 1, failed: 0, skipped: 3 });
  });

  it("기안자 본인이 고른 기안은 실패(self-approval 금지)로 돌려주고 나머지는 계속한다", async () => {
    seed("mine", { createdBy: "owner@example.com" });
    seed("bot");

    const json = await (await POST(makeRequest({ ids: ["mine", "bot"] }))).json();

    expect(json.results[0]).toMatchObject({ id: "mine", ok: false, outcome: "failed", status: "PENDING_APPROVAL" });
    expect(json.results[1]).toMatchObject({ id: "bot", ok: true, outcome: "executed" });
    expect(store.get("mine")?.status).toBe("PENDING_APPROVAL");
  });
});
