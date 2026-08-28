/**
 * GET /api/action-proposals/[id] — 상세(events 포함, entity명 해석) (청사진 §2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAuthMock = vi.fn();
const findByIdMock = vi.fn();
const resolveEntityLabelMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
  },
  // 라우트가 payload/executionResult 역직렬화에 사용 — 문자열이면 파싱, 객체면 그대로(실제 구현과 동일).
  deserializeJsonField: (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v),
}));

vi.mock("@/lib/agent/resolve-entity-label", () => ({
  resolveEntityLabel: (...args: unknown[]) => resolveEntityLabelMock(...args),
}));

const { GET } = await import("./route");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(id: string) {
  return new NextRequest(`http://localhost/api/action-proposals/${id}`);
}

describe("GET /api/action-proposals/[id]", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    findByIdMock.mockReset();
    resolveEntityLabelMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", role: "admin" } });
  });

  it("비인증 시 401을 반환한다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(makeRequest("proposal-1"), makeParams("proposal-1"));
    expect(res.status).toBe(401);
  });

  it("존재하지 않으면 404를 반환한다", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await GET(makeRequest("proposal-x"), makeParams("proposal-x"));
    expect(res.status).toBe(404);
  });

  it("events를 포함해 조회하고 targetEntityName을 해석해 붙인다", async () => {
    findByIdMock.mockResolvedValue({
      id: "proposal-1",
      title: "메모 기안",
      status: "PENDING_APPROVAL",
      targetEntityType: "CAMPAIGN",
      targetEntityId: "camp-1",
      payload: { action: "add_entity_memo", args: { content: "메모" } },
      events: [{ id: "ev1", fromStatus: null, toStatus: "PENDING_APPROVAL" }],
    });
    resolveEntityLabelMock.mockResolvedValue("여름 프로모션");

    const res = await GET(makeRequest("proposal-1"), makeParams("proposal-1"));
    const body = await res.json();

    expect(findByIdMock).toHaveBeenCalledWith(
      "proposal-1",
      expect.objectContaining({ events: expect.anything() })
    );
    expect(body.targetEntityName).toBe("여름 프로모션");
    expect(body.events).toHaveLength(1);
  });

  it("SQLite처럼 payload가 문자열로 저장된 경우 역직렬화해 객체로 반환한다(카드 라벨 dev:local 버그 방지)", async () => {
    requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", role: "admin" } });
    findByIdMock.mockResolvedValue({
      id: "proposal-2",
      title: "정산 기안",
      status: "PENDING_APPROVAL",
      targetEntityType: "CAMPAIGN",
      targetEntityId: "camp-2",
      // SQLite 저장 형태: JSON 문자열
      payload: JSON.stringify({ action: "confirm_settlement", args: { campaignId: "camp-2", target: "payout" } }),
      executionResult: null,
      events: [],
    });
    resolveEntityLabelMock.mockResolvedValue("정산 캠페인");

    const res = await GET(makeRequest("proposal-2"), makeParams("proposal-2"));
    const body = await res.json();

    // 문자열이 아니라 객체로 와야 UI가 payload.action을 읽을 수 있다.
    expect(typeof body.payload).toBe("object");
    expect(body.payload.action).toBe("confirm_settlement");
  });
});
