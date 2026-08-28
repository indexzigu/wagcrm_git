/**
 * GET /api/action-proposals — 승인 대기함 목록 (청사진 §2).
 * requireAuth, status 필터(기본 PENDING_APPROVAL), 최신순, take 제한, 각 항목
 * targetEntity명 서버 해석(§0-6)을 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAuthMock = vi.fn();
const findManyMock = vi.fn();
const resolveEntityLabelMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
  // 라우트가 payload 역직렬화에 사용 — 문자열이면 파싱, 객체면 그대로(실제 구현과 동일).
  deserializeJsonField: (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v),
}));

vi.mock("@/lib/agent/resolve-entity-label", () => ({
  resolveEntityLabel: (...args: unknown[]) => resolveEntityLabelMock(...args),
}));

const { GET } = await import("./route");

function makeRequest(query = "") {
  return new NextRequest(`http://localhost/api/action-proposals${query}`);
}

describe("GET /api/action-proposals", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    findManyMock.mockReset();
    resolveEntityLabelMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", role: "admin" } });
    resolveEntityLabelMock.mockResolvedValue("락토핏 골드");
  });

  it("비인증 시 401을 반환한다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("기본 status 필터는 PENDING_APPROVAL이고 최신순 정렬이다", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest());

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING_APPROVAL" }),
        orderBy: expect.objectContaining({ createdAt: "desc" }),
      })
    );
  });

  it("status 쿼리 파라미터로 다른 상태를 필터링할 수 있다", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest("?status=EXECUTED"));

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "EXECUTED" }) })
    );
  });

  it("m2: 유효한 ActionProposalStatus enum 값 전부를 필터로 허용한다", async () => {
    findManyMock.mockResolvedValue([]);
    for (const status of ["DRAFT", "PENDING_APPROVAL", "APPROVED", "EXECUTED", "REJECTED", "FAILED"]) {
      findManyMock.mockClear();
      await GET(makeRequest(`?status=${status}`));
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status }) })
      );
    }
  });

  it("m2 [Minor, 보안]: 화이트리스트 밖의 임의 문자열은 기본값(PENDING_APPROVAL)으로 좁혀진다", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest("?status=' OR 1=1--"));

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "PENDING_APPROVAL" }) })
    );
  });

  it("m2: 소문자/공백 등 대소문자가 다른 값도 화이트리스트를 통과하지 못하면 기본값으로 좁혀진다", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest("?status=executed"));

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "PENDING_APPROVAL" }) })
    );
  });

  it("각 항목에 서버에서 해석한 targetEntityName이 포함된다", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "proposal-1",
        title: "메모 기안",
        status: "PENDING_APPROVAL",
        kind: "WRITE",
        targetEntityType: "DEAL",
        targetEntityId: "deal-1",
        payload: { action: "add_entity_memo", args: { content: "메모" } },
        createdBy: "user-1",
        createdAt: new Date("2026-07-06T00:00:00Z"),
      },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(resolveEntityLabelMock).toHaveBeenCalledWith("DEAL", "deal-1");
    expect(body.items[0].targetEntityName).toBe("락토핏 골드");
  });

  it("take 제한이 걸려 있다 (무한정 조회 방지)", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest());

    const args = findManyMock.mock.calls[0][0];
    expect(typeof args.take).toBe("number");
    expect(args.take).toBeGreaterThan(0);
    expect(args.take).toBeLessThanOrEqual(200);
  });
});
