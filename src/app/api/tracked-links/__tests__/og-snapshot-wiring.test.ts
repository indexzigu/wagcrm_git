import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 발급 라우트가 OG 수집을 **`after()` 에 실어 보내는지**의 계약.
 *
 * 이 배선은 조용히 깨진다 — 훅을 안 걸어도 발급은 성공하고 테스트도 초록이며, 몇 주 뒤
 * "미리보기가 안 뜬다"로만 드러난다. 그래서 훅에 실렸는지를 직접 본다.
 */

const afterCallbacks: Array<() => unknown> = [];

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => unknown) => {
      afterCallbacks.push(cb);
    },
  };
});

const ensureCampaignTrackedLink = vi.fn();
vi.mock("@/lib/short-link", async () => {
  const actual = await vi.importActual<typeof import("@/lib/short-link")>("@/lib/short-link");
  return {
    ...actual,
    ensureCampaignTrackedLink: (...args: unknown[]) => ensureCampaignTrackedLink(...args),
  };
});

const collectOgSnapshot = vi.fn();
vi.mock("@/lib/og-snapshot", () => ({
  collectOgSnapshot: (...args: unknown[]) => collectOgSnapshot(...args),
}));

const update = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ trackedLink: { update } }),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAuth: async () => ({ authenticated: true }),
}));

function postRequest(body: unknown) {
  return new Request("http://localhost/api/tracked-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  afterCallbacks.length = 0;
  ensureCampaignTrackedLink.mockResolvedValue({
    id: "tl1",
    code: "abcd2345",
    targetUrl: "https://brand.example.com/p/1",
    ogFetchedAt: null,
  });
  collectOgSnapshot.mockResolvedValue({
    title: "여름 공구",
    image: "https://cdn.example.com/a.png",
    description: null,
  });
  update.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tracked-links — OG 스냅샷 배선", () => {
  it("발급 응답을 막지 않고 after() 에서 스냅샷을 채운다", async () => {
    const { POST } = await import("@/app/api/tracked-links/route");
    const res = await POST(postRequest({ campaignId: "c1" }));

    expect(res.status).toBe(201);
    // 응답 시점에는 아직 수집하지 않았다 — 발급이 목적지 응답을 기다리면 안 된다.
    expect(collectOgSnapshot).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
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
  });

  it("수집이 실패하면 아무것도 쓰지 않는다", async () => {
    // 빈 스냅샷을 저장하면 ogFetchedAt 만 찍혀 24시간 동안 폴백까지 막힌다.
    collectOgSnapshot.mockResolvedValue(null);
    const { POST } = await import("@/app/api/tracked-links/route");
    await POST(postRequest({ campaignId: "c1" }));
    await afterCallbacks[0]();
    expect(update).not.toHaveBeenCalled();
  });

  it("이미 스냅샷이 있는 링크는 다시 긁지 않는다", async () => {
    // 발급은 캠페인당 멱등이라 같은 링크로 재요청이 들어온다.
    ensureCampaignTrackedLink.mockResolvedValue({
      id: "tl1",
      code: "abcd2345",
      targetUrl: "https://brand.example.com/p/1",
      ogFetchedAt: new Date(),
    });
    const { POST } = await import("@/app/api/tracked-links/route");
    await POST(postRequest({ campaignId: "c1" }));
    expect(afterCallbacks).toHaveLength(0);
  });
});
