import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 일일 참여 수집기의 **자동수집 메모 갱신** 배선 — 게시 후 광고 표기 점검(claims/ad-disclosure)은
 * `Asset.notes` 의 자동수집 캡션을 읽는다. 수집기가 최신 캡션으로 그 메모를 갱신하지 않으면
 * 셀러가 캡션을 고쳐도 배지가 영영 남는다.
 *
 * 지키는 것: 오너 수기 메모(접두 없음)는 절대 덮지 않는다 · 같은 값·빈 캡션은 쓰지 않는다.
 */

const campaignFindManyMock = vi.fn();
const assetFindManyMock = vi.fn();
const assetUpdateMock = vi.fn();
const scrapeTier0Mock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany: (...a: unknown[]) => campaignFindManyMock(...a) },
    asset: {
      findMany: (...a: unknown[]) => assetFindManyMock(...a),
      update: (args: unknown) => {
        assetUpdateMock(args);
        return args;
      },
    },
    $transaction: async (ops: unknown[]) => ops,
  }),
}));
vi.mock("@/lib/seller-analysis/graphScraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller-analysis/graphScraper")>();
  return {
    ...actual,
    isGraphConfigured: () => true,
    scrapeTier0: (...a: unknown[]) => scrapeTier0Mock(...a),
  };
});
vi.mock("@/lib/instagram-token", () => ({
  applyDbInstagramToken: vi.fn().mockResolvedValue({ source: "env", expiresAt: null }),
}));

import { syncCampaignPostEngagement } from "../campaign-engagement-collector";
import { AUTO_NOTE_PREFIX } from "@/lib/reference-enrich";

const post = (shortcode: string, caption: string) => ({
  shortcode,
  caption,
  likes: 10,
  comments_count: 1,
  likes_hidden: false,
  media_type: "image",
  taken_at: null,
  video_url: null,
});

const asset = (id: string, notes: string | null) => ({
  id,
  entityId: "c1",
  externalUrl: `https://www.instagram.com/p/${id.toUpperCase()}/`,
  engagementSyncedAt: null,
  notes,
});

function notesWritten(): Record<string, string | undefined> {
  return Object.fromEntries(
    assetUpdateMock.mock.calls.map(([args]) => {
      const { where, data } = args as { where: { id: string }; data: { notes?: string } };
      return [where.id, data.notes];
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_COLLECT_MODE", "live");
  campaignFindManyMock.mockReset().mockResolvedValue([{ id: "c1", seller: { id: "s1", snsHandle: "h1" } }]);
  assetUpdateMock.mockReset();
  scrapeTier0Mock.mockReset();
});

describe("syncCampaignPostEngagement — 자동수집 메모 갱신", () => {
  it("빈 메모는 채우고, 자동수집 메모는 갱신하고, 오너 메모는 그대로 둔다", async () => {
    assetFindManyMock.mockReset().mockResolvedValue([
      asset("empty1", null),
      asset("auto1", `${AUTO_NOTE_PREFIX}옛 캡션 · 좋아요 10`),
      asset("memo1", "셀러에게 재촬영 요청함"),
      asset("same1", `${AUTO_NOTE_PREFIX}#광고 그대로 · 좋아요 10`),
    ]);
    scrapeTier0Mock.mockResolvedValue({
      raw_posts: [
        post("EMPTY1", "#광고 새 게시물"),
        post("AUTO1", "#협찬 고친 캡션\n둘째 줄"),
        post("MEMO1", "#광고 무엇이든"),
        post("SAME1", "#광고 그대로"),
      ],
    });

    const result = await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(result.assetsUpdated).toBe(4);
    expect(notesWritten()).toEqual({
      empty1: `${AUTO_NOTE_PREFIX}#광고 새 게시물 · 좋아요 10`,
      auto1: `${AUTO_NOTE_PREFIX}#협찬 고친 캡션\n둘째 줄 · 좋아요 10`,
      memo1: undefined,
      same1: undefined,
    });
  });

  it("캡션이 비어 오면 기존 자동수집 메모를 지우지 않는다", async () => {
    assetFindManyMock.mockReset().mockResolvedValue([asset("keep1", `${AUTO_NOTE_PREFIX}#광고 기존`)]);
    scrapeTier0Mock.mockResolvedValue({ raw_posts: [post("KEEP1", "")] });

    await syncCampaignPostEngagement({ spacingMs: 0 });

    expect(notesWritten()).toEqual({ keep1: undefined });
  });
});
