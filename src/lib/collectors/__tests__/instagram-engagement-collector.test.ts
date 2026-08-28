import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// collect-instagram 통합 최적화(2026-07-11) 회귀 가드:
// 2단계(ER) 수집기가 같은 Tier0 BD 응답으로 셀러 프로필 전체(팔로워·게시물수·bio·프로필사진·
// 외부링크)를 recordSellerMetricsSnapshot에 넘겨 1단계(경량 프로필 수집)를 무손실 대체하는지 검증.
// 이게 깨지면 1단계 중복 조회가 다시 필요해지거나(비효율) profileExternalUrls 회귀가 생긴다.

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const scrapeTier0Mock = vi.fn();
const recordSnapshotMock = vi.fn();
const computeMetricsMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: { findMany: (...a: unknown[]) => findManyMock(...a) },
    sellersHistory: { findFirst: (...a: unknown[]) => findFirstMock(...a) },
  }),
}));
// graphScraper는 scrapeTier0(네트워크)만 목킹하고 mapBusinessDiscovery(순수 매핑)는 실물을 쓴다 —
// tier0Data가 raw BD → 실제 매핑을 거치므로 profile 키 리네임 시 이 테스트가 함께 깨진다(LOW 가드).
vi.mock("@/lib/seller-analysis/graphScraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-analysis/graphScraper")>();
  return {
    ...actual,
    isGraphConfigured: () => true,
    scrapeTier0: (...a: unknown[]) => scrapeTier0Mock(...a),
  };
});
vi.mock("@/lib/seller-analysis/metrics", () => ({
  computeSellerMetrics: (...a: unknown[]) => computeMetricsMock(...a),
}));
vi.mock("@/lib/seller-history", () => ({
  recordSellerMetricsSnapshot: (...a: unknown[]) => recordSnapshotMock(...a),
}));

import { collectInstagramEngagement } from "../instagram-engagement-collector";
import { mapBusinessDiscovery } from "@/lib/seller-analysis/graphScraper";

// raw Graph BD 응답 → 실제 mapBusinessDiscovery로 매핑 (수집기가 소비하는 profile 형태를 정확히 재현)
function tier0FromBD(bd: Record<string, unknown>) {
  return mapBusinessDiscovery(bd, "handle");
}

describe("collectInstagramEngagement — 프로필 전체 커버(1단계 대체)", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "live");
    findManyMock.mockReset();
    findFirstMock.mockReset().mockResolvedValue(null); // 신선한 ER 없음 → 처리 대상
    scrapeTier0Mock.mockReset();
    recordSnapshotMock.mockReset().mockResolvedValue({ profilePicUrl: null });
    computeMetricsMock.mockReset().mockReturnValue({
      engagement: { er: 1.2, avgLikes: 100, avgComments: 5 },
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("BD 응답의 프로필사진·외부링크(website)를 스냅샷에 함께 넘긴다", async () => {
    findManyMock.mockResolvedValue([{ id: "s1", snsHandle: "nari_c" }]);
    scrapeTier0Mock.mockResolvedValue(
      tier0FromBD({
        followers_count: 21000,
        media_count: 540,
        biography: "나리 채널",
        profile_picture_url: "https://cdn.example/nari.jpg",
        website: "https://nari.shop",
      }),
    );

    const res = await collectInstagramEngagement({ spacingMs: 0 });
    expect(res.collectedCount).toBe(1);

    const [, followers, source, metrics, engagement] = recordSnapshotMock.mock.calls[0];
    expect(followers).toBe(21000);
    expect(source).toBe("GRAPH_ER");
    // 1단계 프로필 필드를 전부 커버
    expect(metrics.postsCount).toBe(540);
    expect(metrics.profileBio).toBe("나리 채널");
    expect(metrics.profilePicUrl).toBe("https://cdn.example/nari.jpg");
    expect(metrics.profileExternalUrls).toEqual(["https://nari.shop"]);
    // ER도 함께
    expect(engagement.er).toBe(1.2);
  });

  it("website가 없으면 profileExternalUrls=[] — 링크 제거를 동기화(1단계 clear 시맨틱 등가)", async () => {
    findManyMock.mockResolvedValue([{ id: "s1", snsHandle: "nolink" }]);
    scrapeTier0Mock.mockResolvedValue(
      tier0FromBD({ followers_count: 1000, media_count: 10, biography: "x", profile_picture_url: "https://cdn.example/x.jpg" }),
    );

    await collectInstagramEngagement({ spacingMs: 0 });
    const [, , , metrics] = recordSnapshotMock.mock.calls[0];
    // BD 응답 도달=조회 성공 → 링크 없으면 빈 배열로 지운다(undefined로 방치하면 죽은 링크 잔존)
    expect(metrics.profileExternalUrls).toEqual([]);
  });
});
