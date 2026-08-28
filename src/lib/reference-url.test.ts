import { describe, it, expect } from "vitest";
import {
  normalizeReferenceUrl,
  deriveLinkName,
  isContentDomain,
  extractContentUrls,
} from "./reference-url";

describe("normalizeReferenceUrl", () => {
  it("strips tracking query and hash from instagram share links", () => {
    expect(
      normalizeReferenceUrl("https://www.instagram.com/reel/DEF456/?igsh=abc123&utm_source=share#frag")
    ).toBe("https://www.instagram.com/reel/DEF456/");
  });

  it("strips query on bare instagram.com host too", () => {
    expect(normalizeReferenceUrl("https://instagram.com/p/ABC/?igsh=x")).toBe(
      "https://instagram.com/p/ABC/"
    );
  });

  it("returns null for plain non-URL strings", () => {
    expect(normalizeReferenceUrl("그냥 텍스트")).toBe(null);
  });

  it("returns null for instagram:// deep links (non-http protocol)", () => {
    expect(normalizeReferenceUrl("instagram://reel/DEF456")).toBe(null);
  });

  it("returns null for other non-http protocols", () => {
    expect(normalizeReferenceUrl("ftp://example.com/file")).toBe(null);
  });

  it("preserves meaningful query strings on non-instagram hosts (youtube ?v=)", () => {
    expect(normalizeReferenceUrl("https://www.youtube.com/watch?v=abc123")).toBe(
      "https://www.youtube.com/watch?v=abc123"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReferenceUrl("  https://blog.naver.com/foo/123  ")).toBe(
      "https://blog.naver.com/foo/123"
    );
  });

  it("keeps youtube query intact after toString() normalization", () => {
    expect(
      normalizeReferenceUrl("https://www.youtube.com/watch?v=abc123&t=42s")
    ).toBe("https://www.youtube.com/watch?v=abc123&t=42s");
  });

  it("normalizes host casing on non-instagram hosts", () => {
    expect(normalizeReferenceUrl("https://WWW.YouTube.com/watch?v=abc123")).toBe(
      "https://www.youtube.com/watch?v=abc123"
    );
  });
});

describe("deriveLinkName", () => {
  it("shortens to host (www. removed) + first two path segments", () => {
    expect(deriveLinkName("https://www.instagram.com/reel/DEF456/")).toBe(
      "instagram.com/reel/DEF456"
    );
  });

  it("truncates deeper paths to two segments", () => {
    expect(deriveLinkName("https://www.youtube.com/c/channel/videos")).toBe(
      "youtube.com/c/channel"
    );
  });

  it("returns host only when there is no path", () => {
    expect(deriveLinkName("https://naver.com")).toBe("naver.com");
  });
});

describe("isContentDomain", () => {
  it("accepts whitelisted content hosts (instagram/tiktok/youtube/naver)", () => {
    expect(isContentDomain("https://www.instagram.com/reel/DEF456/")).toBe(true);
    expect(isContentDomain("https://vt.tiktok.com/ZS123/")).toBe(true);
    expect(isContentDomain("https://youtu.be/abc123")).toBe(true);
    expect(isContentDomain("https://m.blog.naver.com/foo/123")).toBe(true);
    expect(isContentDomain("https://cafe.naver.com/bar/456")).toBe(true);
  });

  it("rejects non-whitelisted hosts (delivery/chit-chat links)", () => {
    expect(isContentDomain("https://tracker.example.com/track/1")).toBe(false);
    expect(isContentDomain("https://naver.com")).toBe(false); // 블로그·카페 서브도메인만 허용
  });

  it("matches host case-insensitively", () => {
    expect(isContentDomain("https://WWW.Instagram.com/p/ABC/")).toBe(true);
  });

  it("rejects non-http(s) and unparseable input", () => {
    expect(isContentDomain("instagram://reel/DEF456")).toBe(false);
    expect(isContentDomain("그냥 텍스트")).toBe(false);
  });
});

describe("extractContentUrls", () => {
  it("passes only content-domain URLs and drops chit-chat/delivery links", () => {
    const text =
      "[10:00] 사장: 이거 봐 https://www.instagram.com/reel/DEF456/\n" +
      "[10:01] 직원: 택배 조회 https://tracker.example.com/track/1 요";
    expect(extractContentUrls(text)).toEqual([
      "https://www.instagram.com/reel/DEF456/",
    ]);
  });

  it("returns empty array when there are no URLs (pure chit-chat)", () => {
    expect(extractContentUrls("[10:00] 사장: 오늘 날씨 좋네요")).toEqual([]);
  });

  it("extracts multiple content URLs across chunked messages", () => {
    const text =
      "[10:00] a: https://www.instagram.com/p/ABC/\n" +
      "[10:05] b: https://youtu.be/xyz789\n" +
      "[10:10] c: https://vt.tiktok.com/ZS999/";
    expect(extractContentUrls(text)).toEqual([
      "https://www.instagram.com/p/ABC/",
      "https://youtu.be/xyz789",
      "https://vt.tiktok.com/ZS999/",
    ]);
  });

  it("strips instagram tracking query during extraction", () => {
    const text =
      "링크 https://www.instagram.com/reel/DEF456/?igsh=abc123&utm_source=share 확인해줘";
    expect(extractContentUrls(text)).toEqual([
      "https://www.instagram.com/reel/DEF456/",
    ]);
  });

  it("trims trailing punctuation adjacent to the URL", () => {
    const text = "여기요(https://youtu.be/abc123). 봐주세요!";
    expect(extractContentUrls(text)).toEqual(["https://youtu.be/abc123"]);
  });

  it("dedups the same content URL appearing multiple times", () => {
    const text =
      "https://www.instagram.com/reel/DEF456/ 봤어? 다시 https://www.instagram.com/reel/DEF456/";
    expect(extractContentUrls(text)).toEqual([
      "https://www.instagram.com/reel/DEF456/",
    ]);
  });
});
