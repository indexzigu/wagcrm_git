import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `CampaignEngagementSyncResult` 카운터 계약 — `enrich-references` 크론의 1단계도 밖에서
 * "시도했는가"를 잴 수 있어야 한다. 그 크론은 두 단계를 합쳐 전량 실패를 선언하는데,
 * 1단계가 그 질문에 답하지 못하면 합산 판정에 구멍이 남는다.
 *
 * 닫는 구멍 두 개(자매 계약 `engagement-counters` 와 같은 축):
 * 1. **설정 게이트로 단계가 아예 못 돈 경우** — 종전에는 모든 카운터가 0이라 "대상이 없던
 *    날"과 구분되지 않았다. 2단계(썸네일 스윕)가 마침 대상 0이면 합산 시도도 0이 되어
 *    **반응 지표 수집이 죽은 채로 SUCCESS** 가 된다.
 * 2. **데드라인 이월분** — 예산이 끝나 손도 못 댄 셀러는 시도가 아니다. 시도로 세면 느린
 *    날이 전량 실패로 오인된다(상시 빨강).
 */

const campaignFindManyMock = vi.fn();
const assetFindManyMock = vi.fn();
const transactionMock = vi.fn();
const assetUpdateMock = vi.fn();
const isGraphConfiguredMock = vi.fn();
const scrapeTier0Mock = vi.fn();
const matchAssetEngagementMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany: (...a: unknown[]) => campaignFindManyMock(...a) },
    asset: {
      findMany: (...a: unknown[]) => assetFindManyMock(...a),
      update: (...a: unknown[]) => assetUpdateMock(...a),
    },
    $transaction: (...a: unknown[]) => transactionMock(...a),
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
vi.mock("@/lib/campaign-post-engagement", () => ({
  matchAssetEngagement: (...a: unknown[]) => matchAssetEngagementMock(...a),
}));

import { syncCampaignPostEngagement } from "../campaign-engagement-collector";

/** 셀러 3명 × 캠페인 1건씩 — 자산도 셀러당 1건이라 감시 대상이 곧 3명이다. */
const CAMPAIGNS = [
  { id: "c1", seller: { id: "s1", snsHandle: "handle1" } },
  { id: "c2", seller: { id: "s2", snsHandle: "handle2" } },
  { id: "c3", seller: { id: "s3", snsHandle: "handle3" } },
];
const ASSETS = CAMPAIGNS.map((c, i) => ({
  id: `a${i + 1}`,
  entityId: c.id,
  externalUrl: `https://www.instagram.com/p/POST${i + 1}/`,
  engagementSyncedAt: null,
}));

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_COLLECT_MODE", "live");
  campaignFindManyMock.mockReset().mockResolvedValue(CAMPAIGNS);
  assetFindManyMock.mockReset().mockResolvedValue(ASSETS);
  transactionMock.mockReset().mockResolvedValue([]);
  assetUpdateMock.mockReset().mockResolvedValue({});
  isGraphConfiguredMock.mockReset().mockReturnValue(true);
  scrapeTier0Mock.mockReset().mockResolvedValue({ raw_posts: [] });
  matchAssetEngagementMock.mockReset().mockReturnValue([]);
});

describe("CampaignEngagementSyncResult 카운터 계약", () => {
  it("Tier0 미설정으로 단계가 막혀도 감시 대상 수가 남는다(대상 없음과 구분된다)", async () => {
    isGraphConfiguredMock.mockReturnValue(false);

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.sellersProcessed).toBe(0);
    expect(result.sellersMonitored).toBe(3);
    // 시도 = 감시 - 스킵 - 이월 = 3 → 이 단계는 헛돌았다.
    expect(result.sellersMonitored - result.sellersSkipped - result.sellersDeferred).toBe(3);
  });

  it("수집 모드 미설정도 시도로 남는다(돌아야 하는데 못 돈 것)", async () => {
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "");

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.sellersMonitored).toBe(3);
    expect(result.sellersMonitored - result.sellersSkipped - result.sellersDeferred).toBe(3);
  });

  it("mock 모드는 의도적 스킵이므로 시도로 세지 않는다(로컬 QA 가 헛빨강이 되지 않게)", async () => {
    // ⚠️ Tier0 미설정(위 케이스)과 다르다 — 저쪽은 "돌아야 하는데 못 돈 것"이고 이쪽은
    //    "돌지 않기로 명시 선택한 것"이다. 같이 취급하면 mock QA 마다 ERROR 가 기록된다.
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "mock");

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.sellersMonitored).toBe(3);
    expect(result.sellersSkipped).toBe(3);
    expect(result.sellersMonitored - result.sellersSkipped - result.sellersDeferred).toBe(0);
  });

  it("활성 창 캠페인이 없으면 감시 수도 0이다(정상 — 상시 빨강 방지)", async () => {
    campaignFindManyMock.mockResolvedValue([]);

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.sellersMonitored).toBe(0);
  });

  it("데드라인으로 손도 못 댄 셀러는 이월로 세어 시도에서 뺀다", async () => {
    // 이미 지난 데드라인 → 첫 셀러에서 바로 중단된다.
    const result = await syncCampaignPostEngagement({ deadlineMs: Date.now() - 1000, spacingMs: 0 });

    expect(result.deadlineReached).toBe(true);
    expect(result.sellersDeferred).toBe(3);
    // 시도 0 — 느린 날을 전량 실패로 오인하지 않는다.
    expect(result.sellersMonitored - result.sellersSkipped - result.sellersDeferred).toBe(0);
  });

  it("전량 실패한 회차는 시도가 그대로 남는다(성공 0이 보여야 한다)", async () => {
    scrapeTier0Mock.mockRejectedValue(new Error("Tier0 BD 실패"));

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.sellersProcessed).toBe(0);
    expect(result.failedCount).toBe(3);
    expect(result.sellersMonitored - result.sellersSkipped - result.sellersDeferred).toBe(3);
  });
});
