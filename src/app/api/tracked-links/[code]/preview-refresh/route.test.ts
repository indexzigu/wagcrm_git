import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 이 라우트는 형제 발급 라우트와 달리 **await 한다**(설계서 §4).
 * "목적지를 다시 읽었나"가 곧 운영자가 알아야 할 답이라, after() 로 미루면
 * 스냅샷이 계속 null 인 채 아무도 모르는 무증상 열화가 된다.
 */

const collectOgSnapshot = vi.fn();
vi.mock("@/lib/og-snapshot", () => ({
  collectOgSnapshot: (...args: unknown[]) => collectOgSnapshot(...args),
}));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ trackedLink: { findUnique, update } }),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAuth: async () => ({ authenticated: true }),
}));

function call(code: string) {
  return new Request(
    `http://localhost/api/tracked-links/${code}/preview-refresh`,
    { method: "POST" },
  );
}

beforeEach(() => {
  findUnique.mockResolvedValue({ id: "tl1", targetUrl: "https://brand.example.com/p/1" });
  collectOgSnapshot.mockResolvedValue({
    title: "여름 공구",
    image: "https://cdn.example.com/a.png",
    description: null,
  });
  update.mockResolvedValue({
    ogTitle: "여름 공구",
    ogImage: "https://cdn.example.com/a.png",
    ogFetchedAt: new Date("2026-08-15T00:00:00.000Z"),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tracked-links/[code]/preview-refresh", () => {
  it("목적지를 다시 읽어 스냅샷을 갱신하고 결과를 응답에 담는다", async () => {
    const { POST } = await import(
      "@/app/api/tracked-links/[code]/preview-refresh/route"
    );
    const res = await POST(call("abcd2345"), {
      params: Promise.resolve({ code: "abcd2345" }),
    });

    expect(res.status).toBe(200);
    expect(collectOgSnapshot).toHaveBeenCalledWith("https://brand.example.com/p/1");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tl1" },
        data: expect.objectContaining({
          ogTitle: "여름 공구",
          ogImage: "https://cdn.example.com/a.png",
        }),
      }),
    );
    await expect(res.json()).resolves.toMatchObject({
      refreshed: true,
      ogTitle: "여름 공구",
    });
  });

  it("건질 게 없으면 아무것도 쓰지 않는다", async () => {
    // 빈 스냅샷을 저장하면 ogFetchedAt 만 찍혀 리다이렉터의 폴백 수집까지 24시간 막힌다.
    collectOgSnapshot.mockResolvedValue(null);
    const { POST } = await import(
      "@/app/api/tracked-links/[code]/preview-refresh/route"
    );
    const res = await POST(call("abcd2345"), {
      params: Promise.resolve({ code: "abcd2345" }),
    });

    expect(update).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ refreshed: false });
  });

  it("없는 코드는 404 이고 목적지를 긁지 않는다", async () => {
    findUnique.mockResolvedValue(null);
    const { POST } = await import(
      "@/app/api/tracked-links/[code]/preview-refresh/route"
    );
    const res = await POST(call("nope1234"), {
      params: Promise.resolve({ code: "nope1234" }),
    });

    expect(res.status).toBe(404);
    expect(collectOgSnapshot).not.toHaveBeenCalled();
  });
});
