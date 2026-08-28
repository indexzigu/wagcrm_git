import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// H1 count 분기 단위테스트 — 라우트 테스트 관례(kakao-uploads route.test.ts)대로
// api-auth와 prisma를 모킹하고 GET 핸들러를 직접 호출한다.

const requireAuthMock = vi.fn();
const findManyMock = vi.fn();
const countMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    referenceInboxItem: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      count: (...args: unknown[]) => countMock(...args),
    },
  }),
}));

function makeRequest(query = ""): Request {
  return new Request(`http://test.local/api/reference-inbox${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({
    authenticated: true,
    context: { userId: "user-1" },
  });
});

describe("GET /api/reference-inbox — count 분기(H1)", () => {
  it("count=1이면 목록 대신 { count }만 반환한다(prisma.count 사용, findMany 미호출)", async () => {
    countMock.mockResolvedValue(7);

    const res = await GET(makeRequest("?status=PENDING&count=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });

    expect(countMock).toHaveBeenCalledWith({ where: { status: "PENDING" } });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("count는 status 필터와 조합된다(DISMISSED)", async () => {
    countMock.mockResolvedValue(0);

    const res = await GET(makeRequest("?status=DISMISSED&count=1"));
    expect(await res.json()).toEqual({ count: 0 });
    expect(countMock).toHaveBeenCalledWith({ where: { status: "DISMISSED" } });
  });

  it("count 파라미터가 없으면 기존 목록 응답을 유지한다(회귀 방지)", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    findManyMock.mockResolvedValue(rows);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: rows });

    expect(findManyMock).toHaveBeenCalledWith({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    expect(countMock).not.toHaveBeenCalled();
  });

  it("잘못된 status는 count 여부와 무관하게 400이다", async () => {
    const res = await GET(makeRequest("?status=NOPE&count=1"));
    expect(res.status).toBe(400);
    expect(countMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("미인증이면 auth 게이트 응답을 그대로 반환한다", async () => {
    const denied = new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    requireAuthMock.mockResolvedValue({ authenticated: false, response: denied });

    const res = await GET(makeRequest("?count=1"));
    expect(res.status).toBe(401);
    expect(countMock).not.toHaveBeenCalled();
  });
});
