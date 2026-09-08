import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 이 크론은 감시 셀러 전원이 실패해도 "요청은 처리했다"는 의미로
 * HTTP 200 을 반환하므로, `failed` 선언이 없으면 `withSystemTaskStatus` 가 SUCCESS 로
 * 기록한다(`CronOutcomeBody` 계약).
 *
 * 시도는 `monitoredCount - skippedCount` 다 — 성공·실패 카운터의 합이 아니다. 쿼터 소진처럼
 * **단계가 통째로 막히면 두 카운터가 모두 0**이라, 그것으로 재면 "감시 셀러가 없는 날"과
 * 구분되지 않는다(`collection-result-counters.contract.test.ts` 가 그 카운터를 고정한다).
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

function collection(over: Partial<Record<string, unknown>> = {}) {
  return {
    successCount: 0,
    failedCount: 0,
    monitoredCount: 0,
    skippedCount: 0,
    dispatchedCount: 0,
    errors: [],
    ...over,
  };
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
    collectMock.mockResolvedValue(collection({ monitoredCount: 3, failedCount: 3 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("3");
  });

  it("쿼터 소진처럼 카운터가 전부 0이어도 감시 대상이 남아 있으면 failed 를 선언한다", async () => {
    collectMock.mockResolvedValue(
      collection({
        monitoredCount: 2,
        errors: [{ sellerId: "SYSTEM", snsHandle: "", error: "quota exceeded" }],
      }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("2");
  });

  it("Apify 비동기 발주에 성공했으면 동기 성공이 0이어도 정상이다", async () => {
    // 🪤 그 경로는 적립을 웹훅에 넘기므로 successCount 가 0인 채로 정상 종료한다 —
    //    발주 수를 성공으로 세지 않으면 정상 실행이 매번 빨강이 된다.
    collectMock.mockResolvedValue(collection({ monitoredCount: 2, dispatchedCount: 2 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("하나라도 성공했으면 정상이다(개별 실패를 승격하지 않는다)", async () => {
    collectMock.mockResolvedValue(
      collection({ monitoredCount: 3, successCount: 1, failedCount: 2 }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("전원 멱등 게이트로 건너뛰면 정상이다(시도 0)", async () => {
    collectMock.mockResolvedValue(collection({ monitoredCount: 2, skippedCount: 2 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("감시 셀러가 0명이면 정상이다(대상 없음 — 상시 빨강 방지)", async () => {
    collectMock.mockResolvedValue(collection());

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });
});
