import { describe, it, expect } from "vitest";
import {
  AUTO_NOTE_PREFIX,
  buildAutoNote,
  classifyReferenceUrl,
  deriveYoutubeThumbnailUrl,
  mapApifyPostItem,
} from "./reference-enrich";

describe("classifyReferenceUrl", () => {
  it("classifies instagram hosts (bare + www)", () => {
    expect(classifyReferenceUrl("https://www.instagram.com/reel/DEF456/")).toBe("INSTAGRAM");
    expect(classifyReferenceUrl("https://instagram.com/p/ABC123/")).toBe("INSTAGRAM");
  });

  it("classifies youtube hosts (youtube.com/www/m/youtu.be)", () => {
    expect(classifyReferenceUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("YOUTUBE");
    expect(classifyReferenceUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("YOUTUBE");
    expect(classifyReferenceUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("YOUTUBE");
    expect(classifyReferenceUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("YOUTUBE");
  });

  it("matches host case-insensitively", () => {
    expect(classifyReferenceUrl("https://WWW.Instagram.com/p/ABC/")).toBe("INSTAGRAM");
  });

  it("returns UNSUPPORTED for other content hosts (tiktok/naver — 후속 대상)", () => {
    expect(classifyReferenceUrl("https://vt.tiktok.com/ZS123/")).toBe("UNSUPPORTED");
    expect(classifyReferenceUrl("https://blog.naver.com/foo/123")).toBe("UNSUPPORTED");
  });

  it("returns UNSUPPORTED for unparseable or non-http(s) input", () => {
    expect(classifyReferenceUrl("그냥 텍스트")).toBe("UNSUPPORTED");
    expect(classifyReferenceUrl("instagram://reel/DEF456")).toBe("UNSUPPORTED");
    expect(classifyReferenceUrl("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("UNSUPPORTED");
  });
});

describe("deriveYoutubeThumbnailUrl", () => {
  const expected = "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg";

  it("derives from watch?v={id}", () => {
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(expected);
  });

  it("derives from youtu.be/{id} (추가 쿼리 무시)", () => {
    expect(deriveYoutubeThumbnailUrl("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(expected);
  });

  it("derives from shorts/{id}", () => {
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(expected);
  });

  it("derives from embed/{id}", () => {
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(expected);
  });

  it("derives from m.youtube.com watch URLs", () => {
    expect(deriveYoutubeThumbnailUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(expected);
  });

  it("returns null when the id fails validation ([A-Za-z0-9_-]{6,20})", () => {
    expect(deriveYoutubeThumbnailUrl("https://youtu.be/abc")).toBe(null); // 6자 미만
    expect(deriveYoutubeThumbnailUrl("https://youtu.be/abc$def123")).toBe(null); // 불허 문자
    expect(
      deriveYoutubeThumbnailUrl("https://youtu.be/aaaaaaaaaaaaaaaaaaaaaaaaa")
    ).toBe(null); // 20자 초과
  });

  it("returns null for non-video youtube URLs (채널·재생목록 등)", () => {
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/@somechannel")).toBe(null);
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/watch")).toBe(null); // v 없음
    expect(deriveYoutubeThumbnailUrl("https://www.youtube.com/")).toBe(null);
  });

  it("returns null for non-youtube URLs", () => {
    expect(deriveYoutubeThumbnailUrl("https://vimeo.com/watch?v=dQw4w9WgXcQ")).toBe(null);
    expect(deriveYoutubeThumbnailUrl("그냥 텍스트")).toBe(null);
  });
});

describe("mapApifyPostItem", () => {
  it("maps Graph-style fields (caption.text / media.display_uri / engagement.like_count)", () => {
    const meta = mapApifyPostItem({
      caption: { text: "그래프 캡션" },
      media: { display_uri: "https://cdn.example.com/1.jpg" },
      engagement: { like_count: 0 },
    });
    expect(meta).toEqual({
      caption: "그래프 캡션",
      thumbnailUrl: "https://cdn.example.com/1.jpg",
      likes: 0, // ?? 체인 — 좋아요 0 보존
    });
  });

  it("maps flat scraper fields (caption / displayUrl / likesCount)", () => {
    const meta = mapApifyPostItem({
      caption: "평면 캡션",
      displayUrl: "https://cdn.example.com/2.jpg",
      likesCount: 123,
    });
    expect(meta).toEqual({
      caption: "평면 캡션",
      thumbnailUrl: "https://cdn.example.com/2.jpg",
      likes: 123,
    });
  });

  it("falls back to images[0] for the thumbnail", () => {
    const meta = mapApifyPostItem({ images: ["https://cdn.example.com/3.jpg"] });
    expect(meta.thumbnailUrl).toBe("https://cdn.example.com/3.jpg");
  });

  it("maps the real apify~instagram-scraper response (extra fields ignored)", () => {
    // 2026-07-08 실호출로 관찰한 실제 응답 키 세트 — 무관 필드가 섞여도 3필드만 정확히 뽑는다.
    const meta = mapApifyPostItem({
      caption: "정말 진실로 제가 직접 겪은 일입니다.",
      likesCount: 215,
      commentsCount: 47,
      displayUrl: "https://scontent-dfw6-1.cdninstagram.com/v/t51.82787-15/731823737.jpg",
      type: "Video",
      shortCode: "DaQEvo5veLH",
      ownerUsername: "soll_market",
      videoViewCount: 11181,
      images: [],
    });
    expect(meta).toEqual({
      caption: "정말 진실로 제가 직접 겪은 일입니다.",
      thumbnailUrl: "https://scontent-dfw6-1.cdninstagram.com/v/t51.82787-15/731823737.jpg",
      likes: 215,
    });
  });

  it("returns all-null meta for non-object input", () => {
    const empty = { caption: null, thumbnailUrl: null, likes: null };
    expect(mapApifyPostItem(null)).toEqual(empty);
    expect(mapApifyPostItem("문자열")).toEqual(empty);
    expect(mapApifyPostItem(42)).toEqual(empty);
    expect(mapApifyPostItem([{ caption: "배열" }])).toEqual(empty);
  });

  it("treats empty strings and non-number likes as missing", () => {
    const meta = mapApifyPostItem({ caption: "", displayUrl: "", likesCount: "123" });
    expect(meta).toEqual({ caption: null, thumbnailUrl: null, likes: null });
  });
});

describe("buildAutoNote", () => {
  it("prefixes [자동수집] and appends likes when present", () => {
    expect(buildAutoNote("공구 오픈합니다", 456)).toBe("[자동수집] 공구 오픈합니다 · 좋아요 456");
  });

  it("omits the likes suffix when likes is null", () => {
    expect(buildAutoNote("공구 오픈합니다", null)).toBe("[자동수집] 공구 오픈합니다");
  });

  it("keeps likes 0 (null이 아니므로 표기)", () => {
    expect(buildAutoNote("캡션", 0)).toBe("[자동수집] 캡션 · 좋아요 0");
  });

  it("truncates the caption to 500 chars", () => {
    const note = buildAutoNote("가".repeat(600), null);
    expect(note).toBe(`${AUTO_NOTE_PREFIX}${"가".repeat(500)}`);
    expect(note.length).toBe(AUTO_NOTE_PREFIX.length + 500);
  });

  it("trims surrounding whitespace before truncation", () => {
    expect(buildAutoNote("  캡션  ", null)).toBe("[자동수집] 캡션");
  });
});
