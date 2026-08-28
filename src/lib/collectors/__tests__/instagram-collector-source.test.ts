import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 스냅샷 출처 라벨 회귀 가드(2026-07-24).
//
// 예전 구현은 `INSTAGRAM_COLLECT_MODE` 문자열을 그대로 라벨로 옮겨, 이 파일에서 Apify
// 실행 코드가 제거된 뒤에도 `mode=apify` 이면 부르지도 않은 `APIFY_API` 가 스냅샷에
// 찍혔다. env 값을 사후에 읽을 수 없는 환경이라 이 라벨이 유일한 관측 창구이므로,
// 라벨은 "모드가 뭐라고 적혀 있나"가 아니라 "실제로 어느 경로가 성공했나"여야 한다.
// 핵심 검증: 비-mock 경로의 두 갈래(공개 스크래퍼 / Graph 폴백)가 **서로 다른 라벨**을
// 받는다 — 같아지면 두 경로를 사후에 구분할 수 없어 이 필드가 다시 무의미해진다.

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();
const apiCallCreateMock = vi.fn();
const recordSnapshotMock = vi.fn();
const proxyFetchMock = vi.fn();
const globalFetchMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: { findMany: (...a: unknown[]) => findManyMock(...a) },
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
// getKstMidnightUTC(순수)는 실물을 쓰고 스냅샷 기록만 목킹한다 — 날짜 키 계산 회귀도 함께 태운다.
vi.mock("@/lib/seller-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-history")>();
  return {
    ...actual,
    recordSellerMetricsSnapshot: (...a: unknown[]) => recordSnapshotMock(...a),
  };
});
vi.stubGlobal("fetch", globalFetchMock);

import { collectInstagramFollowers, INSTAGRAM_SNAPSHOT_SOURCE } from "../instagram-collector";

const CONFIG = {
  appId: "app",
  appSecret: "secret",
  accessToken: "token",
  igBusinessAccountId: "ig-biz",
};

/** 공개 웹 프로필 스크래퍼 성공 응답(`/api/v1/users/web_profile_info/`) */
function scraperOk(followers: number): Response {
  return new Response(
    JSON.stringify({
      data: {
        user: {
          edge_followed_by: { count: followers },
          edge_owner_to_timeline_media: { count: 12 },
          biography: "bio",
          profile_pic_url: "https://cdn.example/p.jpg",
          external_url: "https://shop.example",
          full_name: "handle",
          username: "handle",
        },
      },
    }),
    { status: 200 },
  );
}

/** Meta Graph `business_discovery` 성공 응답 */
function graphOk(followers: number): Response {
  return new Response(JSON.stringify({ business_discovery: { followers_count: followers } }), {
    status: 200,
  });
}

/** 방금 기록된 스냅샷의 출처 라벨(3번째 인자) */
function recordedSource(callIndex = 0): string {
  return recordSnapshotMock.mock.calls[callIndex][2] as string;
}

describe("collectInstagramFollowers — 스냅샷 출처 라벨은 실제 실행 경로를 따른다", () => {
  beforeEach(() => {
    findManyMock.mockReset().mockResolvedValue([
      { id: "s1", snsHandle: "handle", currentFollowers: 1000, currentPostsCount: 10 },
    ]);
    findUniqueMock.mockReset().mockResolvedValue(null); // 오늘 스냅샷 없음
    findFirstMock.mockReset().mockResolvedValue(null); // 최근 수집 이력 없음
    apiCallCreateMock.mockReset().mockResolvedValue({});
    recordSnapshotMock.mockReset().mockResolvedValue({ profilePicUrl: null });
    proxyFetchMock.mockReset();
    globalFetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("스크래퍼가 성공하면 INSTAGRAM_SCRAPER 로 기록한다", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "api");
    proxyFetchMock.mockResolvedValue(scraperOk(2500));

    const res = await collectInstagramFollowers(CONFIG);

    expect(res.successCount).toBe(1);
    expect(globalFetchMock).not.toHaveBeenCalled(); // Graph 폴백을 타지 않았다
    expect(recordedSource()).toBe(INSTAGRAM_SNAPSHOT_SOURCE.SCRAPER);
  });

  it("스크래퍼가 실패해 Graph 폴백이 성공하면 INSTAGRAM_API 로 기록한다", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "api");
    proxyFetchMock.mockRejectedValue(new Error("scraper down"));
    globalFetchMock.mockResolvedValue(graphOk(3100));

    const res = await collectInstagramFollowers(CONFIG);

    expect(res.successCount).toBe(1);
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    expect(recordedSource()).toBe(INSTAGRAM_SNAPSHOT_SOURCE.GRAPH);
  });

  it("두 갈래의 라벨은 서로 다르다(사후에 경로를 구분할 수 있어야 한다)", () => {
    expect(INSTAGRAM_SNAPSHOT_SOURCE.SCRAPER).not.toBe(INSTAGRAM_SNAPSHOT_SOURCE.GRAPH);
  });

  it("mode=apify 여도 Apify 를 부르지 않으므로 APIFY_API 를 찍지 않는다", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "apify");
    proxyFetchMock.mockResolvedValue(scraperOk(4200));

    await collectInstagramFollowers(CONFIG);
    expect(recordedSource()).toBe(INSTAGRAM_SNAPSHOT_SOURCE.SCRAPER);

    // 폴백 갈래도 마찬가지 — 모드 문자열이 라벨을 좌우하지 않는다.
    recordSnapshotMock.mockClear();
    proxyFetchMock.mockRejectedValue(new Error("scraper down"));
    globalFetchMock.mockResolvedValue(graphOk(4200));
    findUniqueMock.mockResolvedValue(null);

    await collectInstagramFollowers(CONFIG);
    expect(recordedSource()).toBe(INSTAGRAM_SNAPSHOT_SOURCE.GRAPH);

    const labels = recordSnapshotMock.mock.calls.map((c) => c[2]);
    expect(labels).not.toContain("APIFY_API");
  });

  it("mock 모드는 MOCK 을 유지한다(난수 저장분을 실수집과 구분)", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "mock");

    const res = await collectInstagramFollowers(CONFIG);

    expect(res.successCount).toBe(1);
    expect(proxyFetchMock).not.toHaveBeenCalled();
    expect(globalFetchMock).not.toHaveBeenCalled();
    expect(recordedSource()).toBe(INSTAGRAM_SNAPSHOT_SOURCE.MOCK);
  });

  it("재수집 게이트(source: not INTERNAL)는 새 라벨도 '외부 수집'으로 계산한다", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "api");
    proxyFetchMock.mockResolvedValue(scraperOk(2500));

    await collectInstagramFollowers(CONFIG);

    const where = findFirstMock.mock.calls[0][0].where;
    expect(where.source).toEqual({ not: "INTERNAL" });
    // 새 라벨이 이 필터에 걸리면 스크래퍼 수집분이 "수동 입력"으로 취급돼 매일 재수집된다.
    expect(INSTAGRAM_SNAPSHOT_SOURCE.SCRAPER).not.toBe("INTERNAL");
  });
});
