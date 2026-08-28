import { describe, expect, it } from "vitest";
import { matchAssetEngagement } from "../campaign-post-engagement";
import { mapBusinessDiscovery } from "../seller-analysis/graphScraper";
import type { RawPost } from "../seller-analysis/types";

function rawPost(shortcode: string | null, overrides?: Partial<RawPost>): RawPost {
  return {
    caption: "",
    likes: 0,
    comments_count: 0,
    sample_comments: [],
    taken_at: null,
    media_type: "image",
    video_view_count: null,
    is_sponsored: false,
    shortcode,
    ...overrides,
  };
}

describe("matchAssetEngagement", () => {
  it("shortcode로 매칭해 좋아요·댓글을 업데이트로 산출한다", () => {
    const updates = matchAssetEngagement(
      [{ id: "a1", externalUrl: "https://www.instagram.com/p/ABC123/" }],
      [rawPost("ABC123", { likes: 120, comments_count: 8, likes_hidden: false })],
    );
    expect(updates).toEqual([
      {
        assetId: "a1",
        likeCount: 120,
        commentCount: 8,
        likesHidden: false,
        mediaType: "image",
        videoUrl: null,
        postedAt: null,
      },
    ]);
  });

  it("/reel/ 수동 URL도 shortcode로 동일 매칭된다 (경로 형태 무관)", () => {
    const updates = matchAssetEngagement(
      [{ id: "a1", externalUrl: "https://www.instagram.com/reel/XYZ789/" }],
      [rawPost("XYZ789", { likes: 55, comments_count: 3 })],
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].likeCount).toBe(55);
  });

  it("좋아요 숨김(likes_hidden)이면 likeCount=null 고정 — 0 센티널·임의 숫자를 저장하지 않는다", () => {
    const updates = matchAssetEngagement(
      [{ id: "a1", externalUrl: "https://www.instagram.com/p/HID111/" }],
      [rawPost("HID111", { likes: 0, comments_count: 14, likes_hidden: true })],
    );
    expect(updates).toEqual([
      {
        assetId: "a1",
        likeCount: null,
        commentCount: 14,
        likesHidden: true,
        mediaType: "image",
        videoUrl: null,
        postedAt: null,
      },
    ]);
  });

  it("미매칭(Tier0 창 밖·비인스타 URL·파싱 불가)은 결과에서 제외 — 기존 값을 건드리지 않는다", () => {
    const updates = matchAssetEngagement(
      [
        { id: "out", externalUrl: "https://www.instagram.com/p/NOTFETCHED/" },
        { id: "naver", externalUrl: "https://blog.naver.com/foo/1" },
        { id: "null", externalUrl: null },
      ],
      [rawPost("ABC123", { likes: 10 })],
    );
    expect(updates).toEqual([]);
  });

  it("한 셀러의 여러 자산을 같은 raw_posts로 일괄 매칭한다", () => {
    const updates = matchAssetEngagement(
      [
        { id: "a1", externalUrl: "https://www.instagram.com/p/AAA111/" },
        { id: "a2", externalUrl: "https://www.instagram.com/p/BBB222/" },
      ],
      [rawPost("AAA111", { likes: 1 }), rawPost("BBB222", { likes: 2, likes_hidden: true })],
    );
    expect(updates.map((u) => [u.assetId, u.likeCount, u.likesHidden])).toEqual([
      ["a1", 1, false],
      ["a2", null, true],
    ]);
  });

  it("표현 자산(유형·영상 URL·게시시각)을 같은 매칭에서 함께 산출한다 — 추가 호출 0", () => {
    const updates = matchAssetEngagement(
      [{ id: "a1", externalUrl: "https://www.instagram.com/reel/RRR111/" }],
      [
        rawPost("RRR111", {
          likes: 42,
          comments_count: 5,
          media_type: "reel",
          video_url: "https://video.example.com/r.mp4",
          taken_at: "2026-07-01T09:00:00.000Z",
        }),
      ],
    );
    expect(updates[0]).toMatchObject({
      mediaType: "reel",
      videoUrl: "https://video.example.com/r.mp4",
      postedAt: new Date("2026-07-01T09:00:00.000Z"),
    });
  });

  it("무효 표현 자산은 null로 방어(알 수 없는 유형·비http URL·깨진 시각)", () => {
    const updates = matchAssetEngagement(
      [{ id: "a1", externalUrl: "https://www.instagram.com/p/DEF999/" }],
      [
        rawPost("DEF999", {
          media_type: "weird" as never,
          video_url: "blob:corrupted",
          taken_at: "not-a-date",
        }),
      ],
    );
    expect(updates[0]).toMatchObject({ mediaType: null, videoUrl: null, postedAt: null });
  });
});

describe("mapBusinessDiscovery likes_hidden 파생", () => {
  const bd = (media: Record<string, unknown>[]) => ({
    username: "seller",
    followers_count: 1000,
    media: { data: media },
  });

  it("like_count가 생략되면 좋아요 숨김 신호로 보존한다(0 센티널과 구분)", () => {
    const data = mapBusinessDiscovery(
      bd([
        { comments_count: 5, permalink: "https://www.instagram.com/p/HID111/" },
        { like_count: 0, comments_count: 2, permalink: "https://www.instagram.com/p/ZERO22/" },
      ]),
      "seller",
    );
    expect(data.raw_posts[0].likes_hidden).toBe(true);
    expect(data.raw_posts[0].likes).toBe(0); // 기존 ER 파이프라인 호환(센티널 유지)
    expect(data.raw_posts[1].likes_hidden).toBe(false);
    expect(data.raw_posts[1].likes).toBe(0);
  });
});
