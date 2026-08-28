import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 유튜브 스냅샷 출처 라벨 회귀 가드(2026-07-31) — `instagram-collector-source.test.ts` 의 짝.
//
// 종전 구현은 두 호출부가 `${mode.toUpperCase()}_API` 로 라벨을 **모드 문자열에서 파생**했다.
// 그런데 이 수집기의 실행 경로는 셋(mock · Data API · Apify)인데 분기는 `apify`·`mock` 이
// 아닌 **모든** 값을 Data API 로 흘리므로, 모드에 따라 존재하지 않는 라벨이 찍혔다:
//   `=api` → `API_API` · `=instagram` → `INSTAGRAM_API`(인스타 Graph 폴백 라벨과 충돌) ·
//   `=mock` → `MOCK_API`(인스타 mock 의 `MOCK` 과 갈라짐).
// 라벨은 "모드가 뭐라고 적혀 있나"가 아니라 "실제로 어느 경로가 성공했나"여야 한다 —
// Vercel sensitive env 는 사후에 읽을 수 없어 이 필드가 유일한 관측 창구이기 때문이다.

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();
const sellerUpdateMock = vi.fn();
const apiCallCreateMock = vi.fn();
const recordFollowersMock = vi.fn();
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
// getKstMidnightUTC(순수)·수집 주기 cutoff 는 실물을 쓰고 스냅샷 기록만 목킹한다.
vi.mock("@/lib/seller-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-history")>();
  return {
    ...actual,
    recordSellerFollowersSnapshot: (...a: unknown[]) => recordFollowersMock(...a),
  };
});
vi.stubGlobal("fetch", globalFetchMock);

import { collectYouTubeSubscribers, YOUTUBE_SNAPSHOT_SOURCE } from "../youtube-collector";
import { INSTAGRAM_SNAPSHOT_SOURCE } from "../instagram-collector";

const CONFIG = { apiKey: "yt-key" };
const HANDLE = "UCtestchannel";

/** YouTube Data API v3 `channels?part=statistics` 성공 응답 */
function dataApiOk(subscribers: number): Response {
  return new Response(
    JSON.stringify({ items: [{ id: HANDLE, statistics: { subscriberCount: String(subscribers) } }] }),
    { status: 200 },
  );
}

/** 방금 기록된 스냅샷의 출처 라벨(3번째 인자) */
function recordedSource(callIndex = 0): string {
  return recordFollowersMock.mock.calls[callIndex][2] as string;
}

describe("collectYouTubeSubscribers — 스냅샷 출처 라벨은 실제 실행 경로를 따른다", () => {
  beforeEach(() => {
    findManyMock.mockReset().mockResolvedValue([
      { id: "s1", snsHandle: HANDLE, currentFollowers: 2000 },
    ]);
    findUniqueMock.mockReset().mockResolvedValue(null); // 오늘 스냅샷 없음
    findFirstMock.mockReset().mockResolvedValue(null); // 최근 수집 이력 없음
    sellerUpdateMock.mockReset().mockResolvedValue({});
    apiCallCreateMock.mockReset().mockResolvedValue({});
    recordFollowersMock.mockReset().mockResolvedValue(undefined);
    globalFetchMock.mockReset();
    // mock 쓰기 게이트가 막지 않도록 로컬 DB 로 둔다(가드 계약은 별도 파일).
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("Data API 가 성공하면 YOUTUBE_API 로 기록한다", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "youtube");
    globalFetchMock.mockResolvedValue(dataApiOk(12345));

    const res = await collectYouTubeSubscribers(CONFIG);

    expect(res.successCount).toBe(1);
    expect(recordedSource()).toBe(YOUTUBE_SNAPSHOT_SOURCE.DATA_API);
  });

  it("mock 모드는 MOCK 을 쓴다 — 인스타와 **같은 문자열**이라 mock 판별이 하나다", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "mock");

    const res = await collectYouTubeSubscribers(CONFIG);

    expect(res.successCount).toBe(1);
    expect(globalFetchMock).not.toHaveBeenCalled(); // 외부 호출 없음
    expect(recordedSource()).toBe(YOUTUBE_SNAPSHOT_SOURCE.MOCK);
    expect(YOUTUBE_SNAPSHOT_SOURCE.MOCK).toBe(INSTAGRAM_SNAPSHOT_SOURCE.MOCK);
    // 은퇴한 파생 라벨이 되살아나지 않았는지 명시적으로 본다.
    expect(recordedSource()).not.toBe("MOCK_API");
  });

  // --- 핵심 회귀: 모드 문자열이 라벨을 좌우하지 않는다 ---
  it.each([
    ["api", "API_API"],
    ["instagram", "INSTAGRAM_API"],
    ["아무거나", "아무거나_API".toUpperCase()],
  ])("mode=%s 여도 Data API 경로면 YOUTUBE_API 다(파생 라벨 %s 를 찍지 않는다)", async (mode, derived) => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", mode);
    globalFetchMock.mockResolvedValue(dataApiOk(777));

    await collectYouTubeSubscribers(CONFIG);

    expect(recordedSource()).toBe(YOUTUBE_SNAPSHOT_SOURCE.DATA_API);
    expect(recordedSource()).not.toBe(derived);
  });

  it("mode=instagram 이 인스타 Graph 라벨을 오염시키지 않는다(경로 구분 보존)", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "instagram");
    globalFetchMock.mockResolvedValue(dataApiOk(555));

    await collectYouTubeSubscribers(CONFIG);

    // 같은 라벨이 두 플랫폼의 다른 경로를 가리키면 사후 경로 구분이 불가능해진다.
    expect(recordedSource()).not.toBe(INSTAGRAM_SNAPSHOT_SOURCE.GRAPH);
  });

  it("세 경로의 라벨은 서로 다르다(사후에 경로를 구분할 수 있어야 한다)", () => {
    const labels = Object.values(YOUTUBE_SNAPSHOT_SOURCE);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("재수집 게이트(source: not INTERNAL)는 새 라벨도 '외부 수집'으로 계산한다", async () => {
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "youtube");
    globalFetchMock.mockResolvedValue(dataApiOk(999));

    await collectYouTubeSubscribers(CONFIG);

    const where = findFirstMock.mock.calls[0][0].where;
    expect(where.source).toEqual({ not: "INTERNAL" });
    // 라벨이 이 필터에 걸리면 수집분이 "수동 입력"으로 취급돼 매일 재수집된다.
    for (const label of Object.values(YOUTUBE_SNAPSHOT_SOURCE)) {
      expect(label).not.toBe("INTERNAL");
    }
  });
});
