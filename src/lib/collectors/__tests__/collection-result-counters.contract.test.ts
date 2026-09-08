import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `CollectionResult` 카운터 계약 — "이번 실행이 통째로 헛돌았는가"를 밖에서 잴 수 있어야 한다.
 *
 * 크론 라우트는 `withSystemTaskStatus` 의 `CronOutcomeBody` 계약에 따라 전량 실패를 선언해야
 * 하는데, 그 판정을 이 결과 타입의 카운터로 한다. 그래서 카운터가 **정직해야** 판정이 성립한다.
 * 종전에는 두 곳이 거짓말을 했고 둘 다 판정을 무력화했다:
 *
 * 1. **멱등 스킵을 성공으로 셌다** — 오늘 이미 수집된 셀러에 `successCount++` 를 해서, 실제
 *    수집이 전량 실패한 날에도 `successCount > 0` 이 됐다. 그 값으로 판정하면 선언이 **영원히
 *    발화하지 않는다**(게이트를 넣어도 산출물이 안 바뀌는 형태).
 * 2. **단계가 통째로 막히면 카운터가 전부 0이었다** — 유튜브 쿼터 소진·키 미설정·모드 미설정은
 *    `SYSTEM` 오류만 남기고 조기 반환해 `successCount`·`failedCount` 가 0이다. 그러면 "대상이
 *    없던 날"과 **구분되지 않아** 정상으로 통과한다.
 *
 * 처방은 판정부가 아니라 카운터다 — `monitoredCount`(감시 대상 수)와 `skippedCount`(멱등·주기
 * 게이트로 건너뛴 수)를 따로 싣는다. 그러면 시도 = `monitoredCount - skippedCount` 로 두 경우가
 * 모두 정직하게 드러난다.
 */

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();
const sellerUpdateMock = vi.fn();
const apiCallCreateMock = vi.fn();
const recordSnapshotMock = vi.fn();
const recordFollowersMock = vi.fn();
const proxyFetchMock = vi.fn();
const globalFetchMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      update: (...a: unknown[]) => sellerUpdateMock(...a),
    },
    sellersHistory: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      findFirst: (...a: unknown[]) => findFirstMock(...a),
    },
    apiCallLog: { create: (...a: unknown[]) => apiCallCreateMock(...a) },
  }),
}));
vi.mock("@/lib/order-converter/fetch-client", () => ({
  proxyFetch: (...a: unknown[]) => proxyFetchMock(...a),
}));
vi.mock("@/lib/seller-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-history")>();
  return {
    ...actual,
    recordSellerMetricsSnapshot: (...a: unknown[]) => recordSnapshotMock(...a),
    recordSellerFollowersSnapshot: (...a: unknown[]) => recordFollowersMock(...a),
  };
});
vi.stubGlobal("fetch", globalFetchMock);

import { collectInstagramFollowers } from "../instagram-collector";
import { collectYouTubeSubscribers } from "../youtube-collector";

const SELLERS = [
  { id: "s1", snsHandle: "handle1", currentFollowers: 10, currentPostsCount: 1 },
  { id: "s2", snsHandle: "handle2", currentFollowers: 20, currentPostsCount: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue(SELLERS);
  findUniqueMock.mockResolvedValue(null);
  findFirstMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CollectionResult 카운터 계약 — 인스타", () => {
  it("오늘 이미 수집된 셀러는 성공이 아니라 스킵으로 센다", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "api");
    findUniqueMock.mockResolvedValue({ id: "snapshot-today" });

    const result = await collectInstagramFollowers({
      appId: "app",
      appSecret: "secret",
      accessToken: "token",
      igBusinessAccountId: "ig-biz",
    });

    expect(result.skippedCount).toBe(2);
    expect(result.successCount).toBe(0);
    // 시도 0 = 이 실행은 헛돈 것이 아니다(전부 이미 수집돼 있었다).
    expect(result.monitoredCount - result.skippedCount).toBe(0);
  });

  it("모드 미설정으로 단계가 막히면 감시 대상이 시도로 남는다(대상 없음과 구분된다)", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "");

    const result = await collectInstagramFollowers({
      appId: "app",
      appSecret: "secret",
      accessToken: "token",
      igBusinessAccountId: "ig-biz",
    });

    expect(result.successCount).toBe(0);
    expect(result.monitoredCount - result.skippedCount).toBe(2);
  });
});

describe("CollectionResult 카운터 계약 — 유튜브", () => {
  it("쿼터 소진으로 조기 반환해도 감시 대상이 시도로 남는다", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "api");
    globalFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }),
        { status: 403 },
      ),
    );

    const result = await collectYouTubeSubscribers({ apiKey: "yt-key" });

    expect(result.successCount).toBe(0);
    // 종전에는 successCount·failedCount 가 모두 0이라 "감시 셀러 0명"과 구분되지 않았다.
    expect(result.monitoredCount - result.skippedCount).toBe(2);
  });

  it("감시 셀러가 없으면 시도도 0이다(정상 — 상시 빨강 방지)", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "api");
    findManyMock.mockResolvedValue([]);

    const result = await collectYouTubeSubscribers({ apiKey: "yt-key" });

    expect(result.monitoredCount).toBe(0);
    expect(result.monitoredCount - result.skippedCount).toBe(0);
  });
});
