import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { refreshCampaignWindowPosts, extractPostsCollectedAt } from "../campaign-posts-refresh";
import { scrapeTier0 } from "../seller-analysis/graphScraper";

// 일간 캠페인 게시물 수집(발행 확인용)의 계약을 고정한다: Tier0 전용·일일 게이트·보존 병합·
// analyzedAt 불변·셀러별 실패 격리. Graph 호출은 mock — 대상 선정·갱신 로직만 본다.
// story-viewer-fetch mock은 미사용 경유 모듈 차단용 — 공유 워크트리에 @sparticuz/chromium이
// prune돼 있어 실모듈 transform이 로컬에서 실패한다(story-capture-targets.test와 동일 사유).
vi.mock("../story-viewer-fetch", () => ({
  fetchStoriesForHandles: vi.fn(async () => []),
}));
vi.mock("../seller-analysis/graphScraper", () => ({
  isGraphConfigured: vi.fn(() => true),
  scrapeTier0: vi.fn(async (handle: string) => ({
    seller_id: handle,
    source_tier: "Tier 0 (Graph API)",
    profile: {},
    images: [],
    raw_posts: [
      {
        caption: "새 게시물",
        likes: 10,
        likes_hidden: false,
        comments_count: 2,
        sample_comments: [],
        taken_at: "2026-07-12T10:00:00.000Z",
        media_type: "IMAGE",
        video_view_count: null,
        is_sponsored: false,
        video_url: null,
        thumbnail_url: "https://cdn.example.com/fresh.jpg",
        shortcode: `fresh-${handle}`,
      },
    ],
  })),
}));

const NOW = new Date("2026-07-13T01:00:00Z");

function campaignRows() {
  const inWindow = { startDate: new Date("2026-07-10T00:00:00Z"), endDate: new Date("2026-07-20T00:00:00Z") };
  return [
    {
      ...inWindow,
      seller: { id: "seller-a", name: "셀러A", alias: null, snsType: "INSTAGRAM", snsHandle: "handle_a" },
    },
    {
      ...inWindow,
      seller: { id: "seller-b", name: "셀러B", alias: null, snsType: "INSTAGRAM", snsHandle: "handle_b" },
    },
  ];
}

function mockPrisma(profilesBySellerId: Record<string, { aiTags: unknown } | null> = {}) {
  const upserts: Array<{ where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    salesCampaign: { findMany: vi.fn(async () => campaignRows()) },
    sellerAiProfile: {
      findUnique: vi.fn(async ({ where }: { where: { sellerId: string } }) =>
        profilesBySellerId[where.sellerId] ?? null,
      ),
      upsert: vi.fn(async (args: (typeof upserts)[number]) => {
        upserts.push(args);
        return args.update;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, upserts };
}

beforeEach(() => {
  vi.mocked(scrapeTier0).mockClear();
});

describe("refreshCampaignWindowPosts", () => {
  it("수집창 셀러의 postsPreview를 갱신하고 postsCollectedAt을 남기되 analyzedAt은 건드리지 않는다", async () => {
    const { prisma, upserts } = mockPrisma();
    const result = await refreshCampaignWindowPosts(prisma, NOW);

    expect(result.activeSellers).toBe(2);
    expect(result.refreshed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(upserts).toHaveLength(2);
    for (const call of upserts) {
      const tags = call.update.aiTags as Record<string, unknown>;
      expect(tags.postsCollectedAt).toBe(NOW.toISOString());
      const preview = tags.postsPreview as Array<{ permalink: string | null }>;
      expect(preview[0]?.permalink).toMatch(/instagram\.com\/p\/fresh-/);
      // AI 분석 필드 불변 계약 — 일간 크론은 aiTags만 만진다("재분석 권장" 신선도 의미 보존)
      expect(call.update).not.toHaveProperty("analyzedAt");
      expect(call.create).not.toHaveProperty("analyzedAt");
    }
  });

  it("기존 프리뷰 중 fresh에 없는 게시물을 보존 병합한다(후보 유실 방지)", async () => {
    const oldPost = { permalink: "https://www.instagram.com/p/old-1/", taken_at: "2026-07-01T00:00:00.000Z" };
    const { prisma, upserts } = mockPrisma({
      "seller-a": { aiTags: { postsPreview: [oldPost], analysisNote: "유지되어야 함" } },
    });
    await refreshCampaignWindowPosts(prisma, NOW);

    const sellerACall = upserts.find(
      (c) => (c.where as { sellerId: string }).sellerId === "seller-a",
    );
    const tags = sellerACall?.update.aiTags as Record<string, unknown>;
    const permalinks = (tags.postsPreview as Array<{ permalink: string | null }>).map((p) => p.permalink);
    expect(permalinks).toContain("https://www.instagram.com/p/old-1/");
    // aiTags의 다른 키(분석 결과 등)도 스프레드로 보존된다
    expect(tags.analysisNote).toBe("유지되어야 함");
  });

  it("오늘(KST) 이미 갱신된 셀러는 건너뛰고 force면 다시 수집한다(일일 게이트)", async () => {
    const todayTag = { postsCollectedAt: new Date("2026-07-13T00:10:00Z").toISOString() };
    const { prisma } = mockPrisma({
      "seller-a": { aiTags: todayTag },
      "seller-b": { aiTags: todayTag },
    });
    const gated = await refreshCampaignWindowPosts(prisma, NOW);
    expect(gated.skipped).toBe(2);
    expect(gated.refreshed).toBe(0);
    expect(vi.mocked(scrapeTier0)).not.toHaveBeenCalled();

    const forced = await refreshCampaignWindowPosts(prisma, NOW, true);
    expect(forced.refreshed).toBe(2);
    expect(vi.mocked(scrapeTier0)).toHaveBeenCalledTimes(2);
  });

  it("sellerIds를 주면 창 안 셀러와의 교집합만 갱신한다(셀러별 수동 수집)", async () => {
    const { prisma, upserts } = mockPrisma();
    const result = await refreshCampaignWindowPosts(prisma, NOW, true, ["seller-a"]);
    expect(result.activeSellers).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(vi.mocked(scrapeTier0)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scrapeTier0)).toHaveBeenCalledWith("handle_a");
    expect(upserts).toHaveLength(1);
  });

  it("창 밖 셀러만 지정하면 Graph 호출 없이 대상 0으로 끝난다(창 판정 비우회)", async () => {
    const { prisma, upserts } = mockPrisma();
    const result = await refreshCampaignWindowPosts(prisma, NOW, true, ["seller-out"]);
    expect(result.activeSellers).toBe(0);
    expect(vi.mocked(scrapeTier0)).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it("한 셀러의 Tier0 실패는 격리되고 나머지는 계속 진행된다(유료 폴백 없음)", async () => {
    vi.mocked(scrapeTier0).mockImplementation(async (handle: string) => {
      if (handle === "handle_a") throw new Error("Graph BD failed: 개인계정");
      return { seller_id: handle, profile: {}, images: [], raw_posts: [] };
    });
    const { prisma, upserts } = mockPrisma();
    const result = await refreshCampaignWindowPosts(prisma, NOW);

    expect(result.refreshed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("handle_a");
    expect(upserts).toHaveLength(1);
  });
});

describe("extractPostsCollectedAt", () => {
  it("aiTags에서 ISO 문자열만 꺼내고 형태 불일치는 null", () => {
    expect(extractPostsCollectedAt({ postsCollectedAt: "2026-07-13T00:00:00.000Z" })).toBe(
      "2026-07-13T00:00:00.000Z",
    );
    expect(extractPostsCollectedAt({ postsCollectedAt: 123 })).toBeNull();
    expect(extractPostsCollectedAt(null)).toBeNull();
    expect(extractPostsCollectedAt([])).toBeNull();
  });
});
