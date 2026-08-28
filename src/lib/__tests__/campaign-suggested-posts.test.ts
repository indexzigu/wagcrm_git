import { describe, it, expect } from "vitest";
import { suggestCampaignPosts, type SuggestablePost } from "../campaign-suggested-posts";

// 캠페인 기간: 2026-07-01 ~ 2026-07-05 (창 = 06-24 ~ 07-06, 리드 7일·트레일 1일)
const START = "2026-07-01T00:00:00.000Z";
const END = "2026-07-05T00:00:00.000Z";

function post(p: Partial<SuggestablePost>): SuggestablePost {
  return {
    permalink: "https://www.instagram.com/p/x/",
    taken_at: "2026-07-03T00:00:00.000Z",
    likes: 100,
    is_gongu: true,
    ...p,
  };
}

describe("suggestCampaignPosts", () => {
  it("is_gongu가 아니어도 포함(전량 노출) — recommended=false로 파생", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/a", is_gongu: false })],
      { startDate: START, endDate: END },
    );
    expect(r).toHaveLength(1);
    expect(r[0].recommended).toBe(false);
  });

  it("is_gongu(공구 감지)면 recommended=true로 자동 홍보 추천(필터 아님)", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/g", is_gongu: true })],
      { startDate: START, endDate: END },
    );
    expect(r).toHaveLength(1);
    expect(r[0].recommended).toBe(true);
  });

  it("`/reel/` 형태로 수동 등록된 게시물도 `/p/` 후보와 같은 게시물로 판정해 제외(shortcode 신원)", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://www.instagram.com/p/SAME/" }),
        post({ permalink: "https://www.instagram.com/p/keep2/" }),
      ],
      {
        startDate: START,
        endDate: END,
        registeredUrls: ["https://www.instagram.com/reel/SAME/"],
      },
    );
    expect(r).toHaveLength(1);
    expect(r[0].permalink).toContain("keep2");
  });

  it("무관(OTHER)으로 분류된 permalink는 후보에서 영구 제외(dismissedUrls)", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://www.instagram.com/p/hide/" }),
        post({ permalink: "https://www.instagram.com/p/keep/" }),
      ],
      {
        startDate: START,
        endDate: END,
        dismissedUrls: ["https://www.instagram.com/p/hide/"],
      },
    );
    expect(r).toHaveLength(1);
    expect(r[0].permalink).toContain("keep");
  });

  it("permalink 없으면 제외", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: null }), post({ permalink: "" })],
      { startDate: START, endDate: END },
    );
    expect(r).toHaveLength(0);
  });

  it("기간 창 밖(시작−7일 이전/종료+1일 이후)은 제외, 창 안은 포함", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://insta/p/before", taken_at: "2026-06-20T00:00:00Z" }), // 창 밖(6/24 이전)
        post({ permalink: "https://insta/p/teaser", taken_at: "2026-06-26T00:00:00Z" }), // 창 안(리드 7일)
        post({ permalink: "https://insta/p/during", taken_at: "2026-07-03T00:00:00Z" }), // 창 안
        post({ permalink: "https://insta/p/after", taken_at: "2026-07-08T00:00:00Z" }), // 창 밖(7/6 이후 = 트레일 1일)
      ],
      { startDate: START, endDate: END },
    );
    expect(r.map((p) => p.permalink)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("teaser"),
        expect.stringContaining("during"),
      ]),
    );
    expect(r).toHaveLength(2);
  });

  it("창이 있는데 taken_at이 없으면 제외(기간 판정 불가)", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/notime", taken_at: null })],
      { startDate: START, endDate: END },
    );
    expect(r).toHaveLength(0);
  });

  it("시작·종료 둘 다 없으면 기간 무시하고 포함(창 판정 불가 → permalink만 있으면 후보)", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/nodate", taken_at: null })],
      {},
    );
    expect(r).toHaveLength(1);
  });

  it("이미 등록된 permalink는 제외(정규화 기준 dedup)", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://www.instagram.com/p/dup/" }),
        post({ permalink: "https://www.instagram.com/p/fresh/" }),
      ],
      {
        startDate: START,
        endDate: END,
        registeredUrls: ["https://www.instagram.com/p/dup/"],
      },
    );
    expect(r).toHaveLength(1);
    expect(r[0].permalink).toContain("fresh");
  });

  it("최신순 정렬(게시시각 내림차순) + 동시각은 원래 순서(안정)", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://insta/p/old", taken_at: "2026-07-01T00:00:00Z", likes: 900 }),
        post({ permalink: "https://insta/p/new", taken_at: "2026-07-05T00:00:00Z", likes: 10 }),
        post({ permalink: "https://insta/p/mid1", taken_at: "2026-07-03T00:00:00Z", likes: 50 }),
        post({ permalink: "https://insta/p/mid2", taken_at: "2026-07-03T00:00:00Z", likes: 999 }),
      ],
      { startDate: START, endDate: END },
    );
    // 좋아요와 무관하게 최신 게시가 먼저, 동시각(mid1·mid2)은 입력 순서 유지
    expect(r.map((p) => p.permalink.match(/p\/(\w+)/)?.[1])).toEqual(["new", "mid1", "mid2", "old"]);
  });

  it("likes가 null/비유한이면 0으로 처리", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/nolikes", likes: null })],
      { startDate: START, endDate: END },
    );
    expect(r[0].likes).toBe(0);
  });

  it("좋아요 숨김·댓글 필드를 전파(3-state: likesHidden·comments)", () => {
    const r = suggestCampaignPosts(
      [
        post({ permalink: "https://insta/p/hidden", taken_at: "2026-07-04T00:00:00Z", likes: 0, likes_hidden: true, comments: 12 }),
        post({ permalink: "https://insta/p/normal", taken_at: "2026-07-02T00:00:00Z", likes: 34, comments: 5 }),
      ],
      { startDate: START, endDate: END },
    );
    const hidden = r.find((p) => p.permalink.includes("hidden"))!;
    const normal = r.find((p) => p.permalink.includes("normal"))!;
    expect(hidden.likesHidden).toBe(true);
    expect(hidden.comments).toBe(12);
    expect(normal.likesHidden).toBe(false);
    expect(normal.comments).toBe(5);
  });

  it("comments가 없으면 null(집계 전)", () => {
    const r = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/nc" })],
      { startDate: START, endDate: END },
    );
    expect(r[0].comments).toBeNull();
  });

  it("리드/트레일 일수 커스터마이즈", () => {
    const early = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/early", taken_at: "2026-06-25T00:00:00Z" })],
      { startDate: START, endDate: END, leadDays: 2 }, // 창 하한 06-29 → 06-25 제외
    );
    expect(early).toHaveLength(0);
    const late = suggestCampaignPosts(
      [post({ permalink: "https://insta/p/late", taken_at: "2026-07-07T00:00:00Z" })],
      { startDate: START, endDate: END, trailDays: 5 }, // 창 상한 07-10 → 07-07 포함
    );
    expect(late).toHaveLength(1);
  });
});
