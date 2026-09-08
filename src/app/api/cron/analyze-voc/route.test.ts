import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 분석을 시도한 딜이 전량 실패해도 HTTP 200 이라 `failed` 선언이
 * 없으면 SUCCESS 로 기록된다(`CronOutcomeBody` 계약).
 *
 * ⚠️ **dirty 딜이 없어 분석 0건인 날이 이 잡의 평상시 모습이다**(비용 불변식 I2 — dirty 딜만
 * 분석한다). 그래서 "산출 0"으로 판정하면 거의 매일 빨강이 된다. 경계는 **시도 전량 실패**다.
 *
 * ℹ️ `AnalyzeRunResult` 의 실패 **개수**는 `failedCount` 다 — `failed` 는 계약이 불리언으로
 * 예약한 키라, 개수가 그 이름을 쓰고 있으면 선언이 개수를 조용히 덮어쓴다.
 */

const analyzeMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/order-converter/voc-insight", () => ({
  analyzeDirtyDeals: (...args: unknown[]) => analyzeMock(...args),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/analyze-voc", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

function runResult(over: Partial<Record<string, unknown>> = {}) {
  return {
    candidates: 5,
    dirtyFound: 0,
    analyzed: 0,
    failedCount: 0,
    backlog: 0,
    batchSignal: { avgAnalyzedPerDay7d: 0, backlogConsecutiveRuns: 0, alerted: false },
    deals: [],
    ...over,
  };
}

beforeEach(() => {
  analyzeMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analyze-voc 실질 실패 선언", () => {
  it("분석을 시도한 딜이 전량 실패하면 failed 를 선언한다", async () => {
    analyzeMock.mockResolvedValue(runResult({ dirtyFound: 3, analyzed: 0, failedCount: 3 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("3");
  });

  it("하나라도 분석에 성공했으면 정상이다", async () => {
    analyzeMock.mockResolvedValue(runResult({ dirtyFound: 3, analyzed: 1, failedCount: 2 }));

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("dirty 딜이 없어 분석 0건이면 정상이다(이 잡의 평상시 모습)", async () => {
    analyzeMock.mockResolvedValue(runResult());

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("실패 개수는 `failedCount` 로 실리고 `failed` 는 불리언 선언 전용이다", async () => {
    analyzeMock.mockResolvedValue(runResult({ dirtyFound: 3, analyzed: 1, failedCount: 2 }));

    const body = await (await call()).json();

    expect(body.failedCount).toBe(2);
    expect(typeof body.failed).toBe("boolean");
  });
});
