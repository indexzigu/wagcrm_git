import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 토큰 갱신 실패 문구 — Meta 오류 코드를 「(code N)」으로 싣는다(자가 정상화 4단계 Task 1).
 * 코드가 빠지면 토큰 만료(190)와 다른 실패를 가를 수 없어 사고 원인이 「원인 불명」에 머문다.
 */

const upsertMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    systemSettings: {
      upsert: (...a: unknown[]) => upsertMock(...a),
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
    },
  }),
}));

import { refreshInstagramToken } from "@/lib/instagram-token";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSTAGRAM_APP_ID", "fake_app");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "fake_secret");
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "fake_token");
  vi.stubGlobal("fetch", fetchMock);
  findUniqueMock.mockResolvedValue(null);
  upsertMock.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("refreshInstagramToken — 실패 문구", () => {
  it("Meta 오류 코드가 있으면 「(code N)」을 싣는다", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: "Error validating access token: Session has expired", code: 190 } }),
    );

    const result = await refreshInstagramToken(new Date("2026-10-21T00:00:00Z"));

    expect(result).toEqual({
      ok: false,
      error: "토큰 교환 실패: Error validating access token: Session has expired (code 190)",
    });
  });

  it("코드가 없으면 종전 문구 그대로다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const result = await refreshInstagramToken();
    expect(result).toEqual({ ok: false, error: "토큰 교환 실패: HTTP 500" });
  });

  it("요청 자체가 실패하면 원인 사슬을 남기고 비밀 값은 가린다", async () => {
    fetchMock.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("GET /oauth/access_token?client_secret=fake_secret&fb_exchange_token=fake_token timeout"),
      }),
    );

    const result = await refreshInstagramToken();

    expect(result).toEqual({
      ok: false,
      error:
        "토큰 교환 요청 실패: fetch failed <- GET /oauth/access_token?client_secret=<가림>&fb_exchange_token=<가림> timeout",
    });
  });
});
