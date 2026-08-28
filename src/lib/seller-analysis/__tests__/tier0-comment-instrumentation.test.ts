// Tier0 댓글 보강의 **계측 계약**을 워터폴 진입점에서 고정한다.
// 순수 어댑터 테스트(apify-comment-usage.test.ts)와 달리 여기서 지키는 것은
// "유료 호출이 나갔으면 성공이든 실패든 ApiCallLog 가 정확히 1행 남는가" 하나다 —
// 이 경로는 '실패해도 분석은 진행' 설계라 회귀가 조용히 통과하기 가장 쉬운 지점이다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LosslessSellerData } from "../types";

const apiCallLogCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create: apiCallLogCreate } }),
}));
vi.mock("@/lib/instagram-token", () => ({ applyDbInstagramToken: vi.fn().mockResolvedValue(undefined) }));

const scrapeTier0 = vi.fn();
vi.mock("../graphScraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graphScraper")>();
  return { ...actual, isGraphConfigured: () => true, scrapeTier0: (h: string) => scrapeTier0(h) };
});

import { scrapeSellerDataWaterfall } from "../scraper";

const TOKEN = "apify_api_TEST_TOKEN_VALUE";

function tier0Fixture(): LosslessSellerData {
  return {
    seller_id: "shop",
    source_tier: "Tier 0 (Graph API)",
    debug_info: "BD ok.",
    profile: { username: "shop", fullName: "", bio: "", follower_count: 1000, following_count: 10, profilePicUrl: null },
    raw_posts: [
      { caption: "공구 오픈합니다", likes: 10, comments_count: 5, sample_comments: [], taken_at: "2026-07-01T00:00:00Z", media_type: "image", video_view_count: null, is_sponsored: false, video_url: null, thumbnail_url: null, shortcode: "AAA" },
      { caption: "일상 기록", likes: 3, comments_count: 1, sample_comments: [], taken_at: "2026-06-30T00:00:00Z", media_type: "image", video_view_count: null, is_sponsored: false, video_url: null, thumbnail_url: null, shortcode: "BBB" },
    ],
    images: [],
  };
}

const origTokens = process.env.APIFY_API_TOKENS;
const origSingle = process.env.APIFY_API_TOKEN;

beforeEach(() => {
  apiCallLogCreate.mockReset().mockResolvedValue({});
  scrapeTier0.mockReset().mockResolvedValue(tier0Fixture());
  process.env.APIFY_API_TOKENS = TOKEN;
  delete process.env.APIFY_API_TOKEN;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (origTokens === undefined) delete process.env.APIFY_API_TOKENS;
  else process.env.APIFY_API_TOKENS = origTokens;
  if (origSingle === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = origSingle;
});

function loggedRow() {
  expect(apiCallLogCreate).toHaveBeenCalledTimes(1);
  const { data } = apiCallLogCreate.mock.calls[0][0];
  return { ...data, meta: JSON.parse(data.metadata) };
}

describe("Tier0 댓글 보강 계측", () => {
  it("성공 호출은 1행 + 실제 채운 게시물 수를 남긴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { postUrl: "https://www.instagram.com/p/AAA/", text: "가격 얼마예요" },
            { postUrl: "https://www.instagram.com/p/BBB/", text: "재입고 언제" },
          ]),
          { status: 200 },
        ),
      ),
    );

    const data = await scrapeSellerDataWaterfall("shop");

    const row = loggedRow();
    expect(row.success).toBe(true);
    expect(row.meta).toMatchObject({ targetPosts: 2, receivedComments: 2, filledPosts: 2, unattributedPosts: 0 });
    expect(row.meta.estimatedCostUsd).toBeGreaterThan(0);
    expect(data.source_tier).toBe("Tier 0 (Graph API + Apify Comments)");
    expect(data.raw_posts[0].sample_comments).toEqual(["가격 얼마예요"]);
  });

  it("HTTP 실패도 1행 남기고 분석은 계속된다(P0 No Silent Failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("monthly usage hard limit exceeded", { status: 402 })));

    const data = await scrapeSellerDataWaterfall("shop");

    const row = loggedRow();
    expect(row.success).toBe(false);
    expect(row.statusCode).toBe(402);
    expect(row.errorMessage).toContain("hard limit");
    expect(row.meta).toMatchObject({ targetPosts: 2, receivedComments: 0, filledPosts: 0, estimatedCostUsd: 0 });
    // 실패해도 Tier1(유료 폴백)으로 강등되지 않는다
    expect(data.source_tier).toBe("Tier 0 (Graph API)");
    expect(data.debug_info).toContain("Apify comments failed");
  });

  it("네트워크 오류도 1행 남긴다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await scrapeSellerDataWaterfall("shop");

    const row = loggedRow();
    expect(row.success).toBe(false);
    expect(row.statusCode).toBe(0);
    expect(row.errorMessage).toBe("ECONNRESET");
  });

  it("액터가 요청 밖 shortcode 를 돌려주면 '귀속 실패'로 드러난다(돈만 쓴 분량)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ postUrl: "https://www.instagram.com/p/ZZZ/", text: "다른 글 댓글" }]), { status: 200 }),
      ),
    );

    await scrapeSellerDataWaterfall("shop");

    const row = loggedRow();
    expect(row.meta).toMatchObject({ receivedComments: 1, postsWithComments: 1, filledPosts: 0, unattributedPosts: 1 });
  });

  it("토큰 미설정이면 호출이 없으므로 기록도 없다(호출 횟수 부풀리기 방지)", async () => {
    delete process.env.APIFY_API_TOKENS;
    delete process.env.APIFY_API_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const data = await scrapeSellerDataWaterfall("shop");

    expect(apiCallLogCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.debug_info).toContain("Comments skipped");
  });

  it("타깃이 될 게시물이 없으면 기록도 없다", async () => {
    const noShortcodes = tier0Fixture();
    noShortcodes.raw_posts.forEach((p) => (p.shortcode = null));
    scrapeTier0.mockResolvedValue(noShortcodes);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await scrapeSellerDataWaterfall("shop");

    expect(apiCallLogCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("기록에 토큰 값이 없다(지문만)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })));

    await scrapeSellerDataWaterfall("shop");

    const { data } = apiCallLogCreate.mock.calls[0][0];
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("token=");
    expect(JSON.parse(data.metadata).tokenFingerprint).toMatch(/^[0-9a-f]{6}$/);
  });
});
