import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 2026-08-31~09-08 실사고의 기계 강제 장치.
 *
 * `runSync` 는 동기화가 통째로 실패해도 **throw 하지 않고** `SyncResult.error` 에 사유를
 * 담아 돌려준다. 라우트가 그 결과를 그대로 `NextResponse.json` 으로 넘기면 HTTP 200 이라
 * `withSystemTaskStatus` 가 SUCCESS 로 기록한다 — `failed` 선언이 없기 때문이다
 * (CronOutcomeBody 계약). 실제로 아웃바운드 프록시가 막힌 9일 동안 이 크론은 매일
 * `{"error":"fetch failed"}` 를 담은 채 **SUCCESS 로 기록됐고**, 마지막 SUCCESS 시각을
 * 보는 지연 감시(`status.sh`)에도 잡히지 않아 주문 동기화가 조용히 멈춰 있었다.
 *
 * 아래 세 경계가 이 판정의 전부다 — **error 가 있으면 실패**, **부분 실패(커서 미전진)도
 * 실패**, **변경 0건은 정상**(그날 주문 변경이 없었을 뿐). 마지막 경계가 무너지면 조용한
 * 날마다 빨강이 되어 습관화로 신호를 잃는다.
 */

const runSyncMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/order-converter/naver-order-sync", () => ({
  runSync: (...args: unknown[]) => runSyncMock(...args),
}));
vi.mock("@/lib/cross-campaign-repurchase", () => ({
  sweepBuyerFingerprints: vi.fn().mockResolvedValue({ inserted: 0, campaigns: 0, snapshotDays: 0 }),
}));
vi.mock("@/lib/cache-tags", () => ({
  ORDER_SYNC_INVALIDATION_TAGS: [],
  revalidateCrmTags: vi.fn(),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/naver-order-sync", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

function syncResult(over: Partial<Record<string, unknown>>) {
  return {
    syncType: "CHANGED",
    changedProductOrderIds: [],
    affectedDates: [],
    fetchedAt: "2026-09-08T00:00:00.000Z",
    skipped: false,
    ...over,
  };
}

beforeEach(() => {
  runSyncMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("naver-order-sync 실질 실패 선언", () => {
  it("동기화가 error 를 담아 돌아오면 failed 를 선언한다(9일 무음 실패의 형태)", async () => {
    runSyncMock.mockResolvedValue(syncResult({ error: "fetch failed" }));

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("fetch failed");
  });

  it("부분 실패로 커서가 전진하지 않아도 failed 를 선언한다", async () => {
    runSyncMock.mockResolvedValue(
      syncResult({
        affectedDates: ["2026-09-08"],
        error: "일부 날짜의 변경분 저장에 실패해 커서를 전진시키지 않았습니다.",
      }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
  });

  it("변경 0건이어도 error 가 없으면 정상이다(그날 주문 변경이 없었을 뿐)", async () => {
    runSyncMock.mockResolvedValue(syncResult({ cursorAdvancedTo: "2026-09-08T00:00:00.000Z" }));

    const body = await (await call()).json();

    expect(body.failed).not.toBe(true);
    expect(body.failureReason).toBeUndefined();
  });
});
