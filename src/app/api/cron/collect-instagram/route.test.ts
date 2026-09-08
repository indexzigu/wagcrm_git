import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 이 크론은 두 단계(1단계 ER·프로필 지표, 2단계 잔여 프로필)를 돌고
 * 전량 실패해도 HTTP 200 을 반환하므로, `failed` 선언이 없으면 SUCCESS 로 기록된다
 * (`CronOutcomeBody` 계약).
 *
 * 경계는 **두 단계를 합쳐** 잰다 — 한 단계가 실패해도 다른 단계가 성공했으면 그 실행은
 * 헛돌지 않았다. 멱등 게이트로 건너뛴 셀러(`skippedCount`)와 데드라인 이월분
 * (`deadlineReached`)은 시도가 아니므로 실패 판정에 넣지 않는다.
 */

const engagementMock = vi.fn();
const followersMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/instagram-token", () => ({
  applyDbInstagramToken: vi.fn().mockResolvedValue({ source: "env", expiresAt: null }),
}));
vi.mock("@/lib/collectors/instagram-engagement-collector", () => ({
  collectInstagramEngagement: (...args: unknown[]) => engagementMock(...args),
}));
vi.mock("@/lib/collectors/instagram-collector", () => ({
  collectInstagramFollowers: (...args: unknown[]) => followersMock(...args),
}));
vi.mock("@/lib/cache-tags", () => ({
  SELLER_METRICS_INVALIDATION_TAGS: [],
  revalidateCrmTags: vi.fn(),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/collect-instagram", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

function engagement(over: Partial<Record<string, unknown>> = {}) {
  return {
    collectedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    deadlineReached: false,
    errors: [],
    ...over,
  };
}

beforeEach(() => {
  engagementMock.mockReset();
  followersMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collect-instagram 실질 실패 선언", () => {
  it("두 단계 모두 시도했는데 전량 실패하면 failed 를 선언한다", async () => {
    engagementMock.mockResolvedValue(engagement({ failedCount: 5 }));
    followersMock.mockResolvedValue({ successCount: 0, failedCount: 2, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("7");
  });

  it("1단계가 전량 실패해도 2단계가 성공했으면 정상이다", async () => {
    engagementMock.mockResolvedValue(engagement({ failedCount: 5 }));
    followersMock.mockResolvedValue({ successCount: 3, failedCount: 0, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("멱등 게이트로 전원 건너뛰면 정상이다(시도 0 — 상시 빨강 방지)", async () => {
    engagementMock.mockResolvedValue(engagement({ skippedCount: 10 }));
    followersMock.mockResolvedValue({ successCount: 0, failedCount: 0, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });
});
