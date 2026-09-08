import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `EngagementCollectionResult` 카운터 계약 — 1단계(ER 지표)도 밖에서 "시도했는가"를 잴 수 있어야
 * 한다. `collect-instagram` 크론은 두 단계를 합쳐 전량 실패를 선언하는데, 1단계가 그 질문에
 * 답하지 못하면 합산 판정에 구멍이 남는다.
 *
 * 닫는 구멍 두 개:
 * 1. **설정 게이트로 단계가 아예 못 돈 경우** — 종전에는 모든 카운터가 0이라 "대상이 없던 날"과
 *    구분되지 않았다. 2단계가 마침 전원 멱등 스킵이면(직전까지 수집이 정상이었으면 흔하다)
 *    합산 시도도 0이 되어 **ER 수집이 죽은 채로 SUCCESS** 가 된다.
 * 2. **데드라인 이월분** — 예산이 끝나 손도 못 댄 셀러는 시도가 아니다. 시도로 세면 느린 날이
 *    전량 실패로 오인된다(상시 빨강).
 */

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const scrapeTier0Mock = vi.fn();
const recordSnapshotMock = vi.fn();
const computeMetricsMock = vi.fn();
const isGraphConfiguredMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: { findMany: (...a: unknown[]) => findManyMock(...a) },
    sellersHistory: { findFirst: (...a: unknown[]) => findFirstMock(...a) },
  }),
}));
vi.mock("@/lib/seller-analysis/graphScraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-analysis/graphScraper")>();
  return {
    ...actual,
    isGraphConfigured: () => isGraphConfiguredMock(),
    scrapeTier0: (...a: unknown[]) => scrapeTier0Mock(...a),
  };
});
vi.mock("@/lib/instagram-token", () => ({
  applyDbInstagramToken: vi.fn().mockResolvedValue({ source: "env", expiresAt: null }),
}));
vi.mock("@/lib/seller-analysis/metrics", () => ({
  computeSellerMetrics: (...a: unknown[]) => computeMetricsMock(...a),
}));
vi.mock("@/lib/seller-history", () => ({
  recordSellerMetricsSnapshot: (...a: unknown[]) => recordSnapshotMock(...a),
}));

import { collectInstagramEngagement } from "../instagram-engagement-collector";

const SELLERS = [
  { id: "s1", snsHandle: "handle1" },
  { id: "s2", snsHandle: "handle2" },
  { id: "s3", snsHandle: "handle3" },
];

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_COLLECT_MODE", "live");
  findManyMock.mockReset().mockResolvedValue(SELLERS);
  findFirstMock.mockReset().mockResolvedValue(null);
  scrapeTier0Mock.mockReset();
  recordSnapshotMock.mockReset().mockResolvedValue({ profilePicUrl: null });
  computeMetricsMock.mockReset().mockReturnValue({
    engagement: { er: 1.2, avgLikes: 100, avgComments: 5 },
  });
  isGraphConfiguredMock.mockReset().mockReturnValue(true);
});

describe("EngagementCollectionResult 카운터 계약", () => {
  it("Tier0 미설정으로 단계가 막혀도 감시 대상 수가 남는다(대상 없음과 구분된다)", async () => {
    isGraphConfiguredMock.mockReturnValue(false);

    const result = await collectInstagramEngagement();

    expect(result.collectedCount).toBe(0);
    expect(result.monitoredCount).toBe(3);
    // 시도 = 감시 - 스킵 - 이월 = 3 → 이 단계는 헛돌았다.
    expect(result.monitoredCount - result.skippedCount - result.deferredCount).toBe(3);
  });

  it("mock 모드는 의도적 스킵이므로 시도로 세지 않는다(로컬 QA 가 헛빨강이 되지 않게)", async () => {
    // ⚠️ Tier0 미설정(위 케이스)과 다르다 — 저쪽은 "돌아야 하는데 못 돈 것"이고 이쪽은
    //    "돌지 않기로 명시 선택한 것"이다. 같이 취급하면 mock QA 마다 ERROR 가 기록된다.
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "mock");

    const result = await collectInstagramEngagement();

    expect(result.monitoredCount).toBe(3);
    expect(result.skippedCount).toBe(3);
    expect(result.monitoredCount - result.skippedCount - result.deferredCount).toBe(0);
  });

  it("감시 셀러가 없으면 감시 수도 0이다(정상 — 상시 빨강 방지)", async () => {
    findManyMock.mockResolvedValue([]);

    const result = await collectInstagramEngagement();

    expect(result.monitoredCount).toBe(0);
  });

  it("데드라인으로 손도 못 댄 셀러는 이월로 세어 시도에서 뺀다", async () => {
    // 이미 지난 데드라인 → 첫 셀러에서 바로 중단된다.
    const result = await collectInstagramEngagement({ deadlineMs: Date.now() - 1000 });

    expect(result.deadlineReached).toBe(true);
    expect(result.deferredCount).toBe(3);
    // 시도 0 — 느린 날을 전량 실패로 오인하지 않는다.
    expect(result.monitoredCount - result.skippedCount - result.deferredCount).toBe(0);
  });
});
