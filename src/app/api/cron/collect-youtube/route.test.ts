import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 이 크론은 감시 셀러 전원이 실패해도 "요청은 처리했다"는 의미로
 * HTTP 200 을 반환하므로, `failed` 선언이 없으면 `withSystemTaskStatus` 가 SUCCESS 로
 * 기록한다(`CronOutcomeBody` 계약). 경계는 **시도 전량 실패 = 실패**,
 * **감시 셀러 0명 = 정상**이다(후자가 무너지면 조용한 날마다 빨강이 된다).
 */

const collectMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/collectors/youtube-collector", () => ({
  collectYouTubeSubscribers: (...args: unknown[]) => collectMock(...args),
}));
vi.mock("@/lib/cache-tags", () => ({
  SELLER_METRICS_INVALIDATION_TAGS: [],
  revalidateCrmTags: vi.fn(),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/collect-youtube", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

beforeEach(() => {
  collectMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collect-youtube 실질 실패 선언", () => {
  it("시도한 셀러가 전원 실패하면 failed 를 선언한다", async () => {
    collectMock.mockResolvedValue({ successCount: 0, failedCount: 3, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("3");
  });

  it("하나라도 성공했으면 정상이다(개별 실패를 승격하지 않는다)", async () => {
    collectMock.mockResolvedValue({ successCount: 1, failedCount: 2, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("감시 셀러가 0명이면 정상이다(대상 없음 — 상시 빨강 방지)", async () => {
    collectMock.mockResolvedValue({ successCount: 0, failedCount: 0, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });
});
