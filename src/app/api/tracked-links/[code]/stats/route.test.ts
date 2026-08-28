/**
 * GET /api/tracked-links/{code}/stats — 기간 파라미터 검증.
 *
 * 왜 이 테스트가 있나: `new Date("아무거나")` 는 던지지 않고 **Invalid Date** 를 만든다.
 * 그게 Prisma 의 `occurredAt: { gte: ... }` 까지 흘러가면 직렬화 시점에
 * `RangeError: Invalid time value` 로 터져 500 이 된다 — 즉 입력 오류가 서버 장애로
 * 보고된다. 교차검증(2026-07-31)에서 지적된 실제 결함이고, 조용히 되돌아오기 쉬운
 * 부류라(검증 한 줄을 지우면 끝) 여기서 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthMock = vi.fn();
const getPrismaMock = vi.fn();
const getLinkStatsMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

vi.mock("@/lib/short-link", () => ({
  getLinkStats: (...args: unknown[]) => getLinkStatsMock(...args),
}));

const { GET } = await import("./route");

const findUnique = vi.fn();

function call(query: string) {
  return GET(new Request(`https://crm.example.com/api/tracked-links/a7Kd9xQm/stats${query}`), {
    params: Promise.resolve({ code: "a7Kd9xQm" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { role: "admin" } });
  findUnique.mockResolvedValue({ id: "l1", code: "a7Kd9xQm" });
  getPrismaMock.mockReturnValue({ trackedLink: { findUnique } });
  getLinkStatsMock.mockResolvedValue({ code: "a7Kd9xQm", totalClicks: 0 });
});

describe("기간 파라미터", () => {
  it("날짜가 아닌 from 은 400 이고, DB 를 건드리지 않는다", async () => {
    const res = await call("?from=어제쯤");

    expect(res.status).toBe(400);
    // 500 이 아니라는 것만으로는 부족하다 — 조회까지 갔다가 터지는 것도 막아야 한다.
    expect(findUnique).not.toHaveBeenCalled();
    expect(getLinkStatsMock).not.toHaveBeenCalled();
  });

  it("빈 문자열은 미지정과 같게 취급한다", async () => {
    // `?from=&to=` 는 기간 필터를 지우는 흔한 조작이다. 이게 400 이면 운영자가
    // 멀쩡한 URL 을 오류로 보게 된다.
    const res = await call("?from=&to=");

    expect(res.status).toBe(200);
    expect(getLinkStatsMock).toHaveBeenCalledWith(
      expect.anything(),
      "a7Kd9xQm",
      expect.objectContaining({ from: undefined, to: undefined }),
    );
  });

  it("정상 날짜는 Date 로 넘긴다", async () => {
    const res = await call("?from=2026-07-01&to=2026-07-31T23:59:59Z&includeBots=1");

    expect(res.status).toBe(200);
    const options = getLinkStatsMock.mock.calls[0][2];
    expect(options.from).toBeInstanceOf(Date);
    expect(options.to).toBeInstanceOf(Date);
    expect(Number.isNaN(options.from.getTime())).toBe(false);
    expect(options.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(options.includeBots).toBe(true);
  });

  it("봇 포함은 명시적으로 1 일 때만 켜진다", async () => {
    await call("?includeBots=true");
    expect(getLinkStatsMock.mock.calls[0][2].includeBots).toBe(false);
  });
});

describe("사전 조건", () => {
  it("미인증이면 그대로 401 응답을 돌려준다", async () => {
    const unauthorized = new Response(null, { status: 401 });
    requireAuthMock.mockResolvedValue({ authenticated: false, response: unauthorized });

    expect(await call("")).toBe(unauthorized);
    expect(getPrismaMock).not.toHaveBeenCalled();
  });

  it("없는 코드는 404 이고 통계를 계산하지 않는다", async () => {
    findUnique.mockResolvedValue(null);

    const res = await call("");
    expect(res.status).toBe(404);
    expect(getLinkStatsMock).not.toHaveBeenCalled();
  });
});
