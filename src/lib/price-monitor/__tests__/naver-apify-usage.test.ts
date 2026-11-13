import { beforeEach, describe, expect, it, vi } from "vitest";

const apiCallLogCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create: apiCallLogCreate } }),
}));

import {
  NAVER_APIFY_ENDPOINT_LABEL,
  NAVER_APIFY_PROVIDER,
  NAVER_APIFY_SCOPE,
  recordNaverApifyUsage,
  type NaverApifyCallUsage,
} from "../naver-apify-usage";

const SECRET = "apify_api_TEST_TOKEN_VALUE";

function usageFixture(overrides: Partial<NaverApifyCallUsage> = {}): NaverApifyCallUsage {
  return {
    statusCode: 200,
    ok: true,
    durationMs: 120,
    errorMessage: null,
    ...overrides,
  };
}

describe("recordNaverApifyUsage", () => {
  beforeEach(() => {
    apiCallLogCreate.mockReset().mockResolvedValue({});
  });

  it("실제 성공 호출을 NAVER/apify scope의 ApiCallLog로 기록한다", async () => {
    await expect(recordNaverApifyUsage(usageFixture())).resolves.toBe(true);

    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      provider: NAVER_APIFY_PROVIDER,
      permissionScope: NAVER_APIFY_SCOPE,
      endpoint: NAVER_APIFY_ENDPOINT_LABEL,
      statusCode: 200,
      success: true,
      errorMessage: null,
    });
    expect(JSON.parse(data.metadata)).toEqual({ durationMs: 120 });
  });

  it("실패한 실제 호출도 성공과 같은 1행 계약으로 기록한다", async () => {
    await expect(
      recordNaverApifyUsage(
        usageFixture({ ok: false, statusCode: 429, errorMessage: "Apify API HTTP 429" }),
      ),
    ).resolves.toBe(true);

    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data.success).toBe(false);
    expect(data.statusCode).toBe(429);
    expect(data.errorMessage).toBe("Apify API HTTP 429");
  });

  it("endpoint와 metadata에 토큰·쿼리를 저장하지 않는다", async () => {
    await recordNaverApifyUsage(usageFixture({ errorMessage: `Bearer ${SECRET}` }));

    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data.endpoint).toBe(NAVER_APIFY_ENDPOINT_LABEL);
    expect(data.endpoint).not.toContain("?");
    expect(data.endpoint).not.toContain("api.apify.com");
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it("계측 저장 실패를 false와 console.error로 표면화한다", async () => {
    apiCallLogCreate.mockRejectedValueOnce(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordNaverApifyUsage(usageFixture())).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
