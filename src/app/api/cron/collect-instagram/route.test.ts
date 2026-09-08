import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 이 크론은 두 단계(1단계 ER·프로필 지표, 2단계 잔여 프로필)를 돌고
 * 전량 실패해도 HTTP 200 을 반환하므로, `failed` 선언이 없으면 SUCCESS 로 기록된다
 * (`CronOutcomeBody` 계약).
 *
 * 경계는 **두 단계를 합쳐** 잰다 — 한 단계가 막혀도 다른 단계가 셀러를 갱신했으면 그 실행은
 * 헛돌지 않았다. 멱등 게이트로 건너뛴 셀러와 데드라인 이월분은 시도가 아니다.
 *
 * ⚠️ 2단계의 시도는 `monitoredCount - skippedCount` 다 — `successCount + failedCount` 가
 * 아니다. 종전에는 건너뛴 셀러까지 `successCount` 로 세서, 실제 수집이 전량 실패한 날에도
 * 그 값이 양수라 이 선언이 **영원히 발화하지 못했을** 것이다.
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

/** 1단계(ER·프로필 지표) 결과 */
function engagement(over: Partial<Record<string, unknown>> = {}) {
  return {
    collectedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    deadlineReached: false,
    monitoredCount: 0,
    deferredCount: 0,
    errors: [],
    ...over,
  };
}

/** 2단계(잔여 프로필) 결과 */
function followers(over: Partial<Record<string, unknown>> = {}) {
  return { successCount: 0, failedCount: 0, monitoredCount: 0, skippedCount: 0, errors: [], ...over };
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
    engagementMock.mockResolvedValue(engagement({ monitoredCount: 5, failedCount: 5 }));
    followersMock.mockResolvedValue(followers({ monitoredCount: 2, failedCount: 2 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("7");
  });

  it("2단계가 모드 미설정으로 통째로 막히고 1단계도 산출이 없으면 failed 를 선언한다", async () => {
    engagementMock.mockResolvedValue(engagement());
    followersMock.mockResolvedValue(
      followers({
        monitoredCount: 6,
        errors: [{ sellerId: "SYSTEM", snsHandle: "", error: "skipped: 미설정" }],
      }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("6");
  });

  it("1단계가 Tier0 미설정으로 막히고 2단계는 전원 스킵이어도 failed 를 선언한다", async () => {
    // 🪤 GPT 리뷰가 짚은 사각. 직전까지 수집이 정상이었으면 2단계는 최근 스냅샷 때문에
    //    전원 스킵되므로, 1단계의 감시 수가 없으면 합산 시도가 0이 되어 ER 수집이 죽은
    //    채로 SUCCESS 가 된다.
    engagementMock.mockResolvedValue(
      engagement({
        monitoredCount: 8,
        errors: [{ sellerId: "SYSTEM", snsHandle: "", error: "skipped: Tier0 미설정" }],
      }),
    );
    followersMock.mockResolvedValue(followers({ monitoredCount: 8, skippedCount: 8 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("8");
  });

  it("1단계가 데드라인으로 이월되고 산출이 없어도 정상이다(이월분은 시도가 아니다)", async () => {
    engagementMock.mockResolvedValue(
      engagement({ monitoredCount: 8, deferredCount: 8, deadlineReached: true }),
    );
    followersMock.mockResolvedValue(followers({ monitoredCount: 8, skippedCount: 8 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("1단계가 전량 실패해도 2단계가 성공했으면 정상이다", async () => {
    engagementMock.mockResolvedValue(engagement({ monitoredCount: 5, failedCount: 5 }));
    followersMock.mockResolvedValue(followers({ monitoredCount: 3, successCount: 3 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("2단계가 전원 멱등 스킵이고 1단계가 수집했으면 정상이다(그날의 평상시)", async () => {
    engagementMock.mockResolvedValue(engagement({ monitoredCount: 6, collectedCount: 6 }));
    followersMock.mockResolvedValue(followers({ monitoredCount: 10, skippedCount: 10 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("양쪽 다 시도가 없으면 정상이다(대상 없음 — 상시 빨강 방지)", async () => {
    engagementMock.mockResolvedValue(engagement({ monitoredCount: 10, skippedCount: 10 }));
    followersMock.mockResolvedValue(followers({ monitoredCount: 10, skippedCount: 10 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });
});
