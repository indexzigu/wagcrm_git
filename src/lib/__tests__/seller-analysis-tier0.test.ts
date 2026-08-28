import { describe, it, expect } from "vitest";
import { mapBusinessDiscovery, shortcodeFromPermalink } from "../seller-analysis/graphScraper";
import { pickCommentTargets, groupCommentsByShortcode } from "../seller-analysis/apifyComments";
import { normalizeMediaType, RawPost } from "../seller-analysis/types";

// ---------- Graph BD → LosslessSellerData 매핑 ----------

const BD_FIXTURE = {
  username: "gaon",
  name: "김본명",
  biography: "가온마켓 | 문의는 DM",
  followers_count: 120000,
  follows_count: 300,
  media_count: 715,
  profile_picture_url: "https://cdn.example/profile.jpg",
  website: "https://seoa.market/shop",
  media: {
    data: [
      {
        caption: "오늘 마감! 가온마켓 최대할인",
        like_count: 1500,
        comments_count: 88,
        timestamp: "2026-07-01T09:00:00+0000",
        media_type: "IMAGE",
        media_url: "https://cdn.example/img1.jpg",
        permalink: "https://www.instagram.com/p/ABC123xyz/",
      },
      {
        caption: "릴스 일상",
        like_count: 900,
        comments_count: 12,
        timestamp: "2026-06-28T09:00:00+0000",
        media_type: "VIDEO",
        media_product_type: "REELS",
        media_url: "https://cdn.example/video.mp4",
        thumbnail_url: "https://cdn.example/poster.jpg",
        permalink: "https://www.instagram.com/reel/DEF456/",
      },
      {
        caption: "캐러셀 게시물",
        like_count: 400,
        comments_count: 5,
        timestamp: 1750000000, // unix 초도 허용
        media_type: "CAROUSEL_ALBUM",
        media_url: "https://cdn.example/car1.jpg",
        permalink: "https://www.instagram.com/p/GHI789/",
      },
    ],
  },
};

describe("mapBusinessDiscovery", () => {
  const data = mapBusinessDiscovery(BD_FIXTURE, "gaon");

  it("프로필 필드를 매핑한다 (media_count 포함 — profileMeta.postsCountTotal 소비)", () => {
    expect(data.profile.username).toBe("gaon");
    expect(data.profile.fullName).toBe("김본명");
    expect(data.profile.bio).toContain("가온마켓");
    expect(data.profile.follower_count).toBe(120000);
    expect(data.profile.following_count).toBe(300);
    expect(data.profile.media_count).toBe(715);
    expect(data.source_tier).toBe("Tier 0 (Graph API)");
  });

  it("website(바이오 외부링크)를 매핑한다 — collect-instagram 통합 시 프로필 갱신이 소비", () => {
    expect(data.profile.website).toBe("https://seoa.market/shop");
    // 없으면 null(빈 문자열도 null) — 갱신 경로가 undefined로 넘겨 기존 값 보존하도록
    expect(mapBusinessDiscovery({ username: "x" }, "x").profile.website).toBeNull();
    expect(mapBusinessDiscovery({ username: "x", website: "" }, "x").profile.website).toBeNull();
  });

  it("게시물을 RawPost로 매핑한다 — 좋아요·댓글수·ISO 타임스탬프", () => {
    expect(data.raw_posts).toHaveLength(3);
    const [first] = data.raw_posts;
    expect(first.likes).toBe(1500);
    expect(first.comments_count).toBe(88);
    expect(first.taken_at).toBe("2026-07-01T09:00:00.000Z");
    expect(data.raw_posts[2].taken_at).toBe(new Date(1750000000 * 1000).toISOString());
  });

  it("media_type을 통일한다 — IMAGE/VIDEO+REELS/CAROUSEL_ALBUM", () => {
    expect(data.raw_posts.map((p) => p.media_type)).toEqual(["image", "reel", "carousel"]);
  });

  it("영상은 thumbnail_url(포스터)을, 이미지는 media_url을 썸네일로 쓴다", () => {
    expect(data.raw_posts[0].thumbnail_url).toBe("https://cdn.example/img1.jpg");
    expect(data.raw_posts[1].thumbnail_url).toBe("https://cdn.example/poster.jpg");
  });

  it("permalink에서 shortcode를 역산한다 (/p/·/reel/ 모두)", () => {
    expect(data.raw_posts.map((p) => p.shortcode)).toEqual(["ABC123xyz", "DEF456", "GHI789"]);
  });

  it("BD 미제공 필드는 결측으로 정직하게 표기한다 — 댓글 빈 배열·is_sponsored false·조회수 null", () => {
    for (const p of data.raw_posts) {
      expect(p.sample_comments).toEqual([]);
      expect(p.is_sponsored).toBe(false);
      expect(p.video_view_count).toBeNull();
    }
  });

  it("images는 프로필 사진을 앞세우고 썸네일을 뒤에 붙인다", () => {
    expect(data.images[0]).toBe("https://cdn.example/profile.jpg");
    expect(data.images).toContain("https://cdn.example/img1.jpg");
  });

  it("media가 없어도 죽지 않는다", () => {
    const empty = mapBusinessDiscovery({ username: "x" }, "x");
    expect(empty.raw_posts).toEqual([]);
  });
});

describe("shortcodeFromPermalink", () => {
  it("p/reel/tv 경로에서 코드를 추출한다", () => {
    expect(shortcodeFromPermalink("https://www.instagram.com/p/AbC-12_3/")).toBe("AbC-12_3");
    expect(shortcodeFromPermalink("https://www.instagram.com/reel/XYZ/")).toBe("XYZ");
    expect(shortcodeFromPermalink("https://www.instagram.com/tv/T1/")).toBe("T1");
  });

  it("비정상 입력은 null", () => {
    expect(shortcodeFromPermalink(null)).toBeNull();
    expect(shortcodeFromPermalink(undefined)).toBeNull();
    expect(shortcodeFromPermalink("https://example.com/p/ABC/")).toBeNull();
    expect(shortcodeFromPermalink("https://www.instagram.com/username/")).toBeNull();
  });
});

describe("normalizeMediaType — Graph API 표기", () => {
  it("REELS product_type과 CAROUSEL_ALBUM을 인식한다", () => {
    expect(normalizeMediaType("VIDEO", "REELS")).toBe("reel");
    expect(normalizeMediaType("CAROUSEL_ALBUM")).toBe("carousel");
    expect(normalizeMediaType("IMAGE")).toBe("image");
  });

  it("기존 표기 회귀 없음 — clips·숫자·Sidecar", () => {
    expect(normalizeMediaType("Video", "clips")).toBe("reel");
    expect(normalizeMediaType(8)).toBe("carousel");
    expect(normalizeMediaType("Sidecar")).toBe("carousel");
  });
});

// ---------- 댓글 타깃팅 + 그룹핑 ----------

function post(overrides: Partial<RawPost>): RawPost {
  return {
    caption: "",
    likes: 0,
    comments_count: 0,
    sample_comments: [],
    taken_at: null,
    media_type: "image",
    video_view_count: null,
    is_sponsored: false,
    thumbnail_url: null,
    shortcode: null,
    ...overrides,
  };
}

describe("pickCommentTargets", () => {
  it("공구글을 앞세우고 남는 슬롯을 일반글로 채운다 (그룹 내 입력 순서 보존)", () => {
    const posts = [
      post({ shortcode: "a", caption: "일상 브이로그" }),
      post({ shortcode: "b", caption: "오늘 마감! 최저가 공구" }),
      post({ shortcode: "c", caption: "고양이 사진" }),
      post({ shortcode: "d", caption: "2차 마켓 오픈합니다" }),
    ];
    expect(pickCommentTargets(posts, 3).map((p) => p.shortcode)).toEqual(["b", "d", "a"]);
  });

  it("shortcode 없는 게시물은 제외하고 max로 캡한다", () => {
    const posts = [
      post({ shortcode: null, caption: "공구 오픈" }),
      ...Array.from({ length: 15 }, (_, i) => post({ shortcode: `s${i}` })),
    ];
    const picked = pickCommentTargets(posts);
    expect(picked).toHaveLength(10);
    expect(picked.every((p) => p.shortcode)).toBe(true);
  });
});

describe("groupCommentsByShortcode", () => {
  it("postUrl 기준으로 shortcode에 그룹핑한다", () => {
    const map = groupCommentsByShortcode([
      { postUrl: "https://www.instagram.com/p/AAA/", text: "어디서 사요?" },
      { postUrl: "https://www.instagram.com/p/AAA/", text: "구매 완료!" },
      { postUrl: "https://www.instagram.com/reel/BBB/", text: "정보 부탁드려요" },
    ]);
    expect(map.get("AAA")).toEqual(["어디서 사요?", "구매 완료!"]);
    expect(map.get("BBB")).toEqual(["정보 부탁드려요"]);
  });

  it("소속 URL·텍스트가 없는 아이템은 조용히 버리지 않고 결과에서만 제외한다", () => {
    const map = groupCommentsByShortcode([
      { text: "떠돌이 댓글" },
      { postUrl: "https://www.instagram.com/p/CCC/", text: "  " },
      { postUrl: "https://www.instagram.com/p/CCC/" },
      null,
    ]);
    expect(map.size).toBe(0);
  });
});
