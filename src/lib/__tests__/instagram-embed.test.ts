import { describe, it, expect } from "vitest";
import { isInstagramPermalink, toEmbedPermalink, instagramShortcode } from "../instagram-embed";

describe("isInstagramPermalink", () => {
  it("게시물/릴스/IGTV 퍼머링크는 true", () => {
    expect(isInstagramPermalink("https://www.instagram.com/p/DaKWpO-k9Ha/")).toBe(true);
    expect(isInstagramPermalink("https://instagram.com/reel/DEF456/")).toBe(true);
    expect(isInstagramPermalink("https://www.instagram.com/tv/ABC123/")).toBe(true);
    expect(isInstagramPermalink("https://www.instagram.com/p/DaKWpO-k9Ha/?utm_source=x")).toBe(true);
  });

  it("프로필/스토리/비 IG/무효 URL은 false", () => {
    expect(isInstagramPermalink("https://www.instagram.com/someuser/")).toBe(false);
    expect(isInstagramPermalink("https://www.instagram.com/stories/user/123/")).toBe(false);
    expect(isInstagramPermalink("https://youtube.com/watch?v=x")).toBe(false);
    expect(isInstagramPermalink("not a url")).toBe(false);
    expect(isInstagramPermalink(null)).toBe(false);
    expect(isInstagramPermalink(undefined)).toBe(false);
    expect(isInstagramPermalink("")).toBe(false);
  });

  it("http(s)가 아니면 false", () => {
    expect(isInstagramPermalink("ftp://instagram.com/p/abc/")).toBe(false);
  });
});

describe("toEmbedPermalink", () => {
  it("표준 형태로 정규화(https·www·후행 슬래시·쿼리 제거)", () => {
    expect(toEmbedPermalink("http://instagram.com/reel/DEF456")).toBe(
      "https://www.instagram.com/reel/DEF456/",
    );
    expect(toEmbedPermalink("https://www.instagram.com/p/DaKWpO-k9Ha/?igsh=abc&utm=1")).toBe(
      "https://www.instagram.com/p/DaKWpO-k9Ha/",
    );
    expect(toEmbedPermalink("https://www.instagram.com/tv/ABC123/#frag")).toBe(
      "https://www.instagram.com/tv/ABC123/",
    );
  });

  it("종류(p/reel/tv)를 보존한다", () => {
    expect(toEmbedPermalink("https://instagram.com/reel/XYZ/")).toContain("/reel/");
    expect(toEmbedPermalink("https://instagram.com/p/XYZ/")).toContain("/p/");
  });

  it("임베드 불가/무효면 null", () => {
    expect(toEmbedPermalink("https://www.instagram.com/someuser/")).toBeNull();
    expect(toEmbedPermalink("https://youtube.com/watch?v=x")).toBeNull();
    expect(toEmbedPermalink("garbage")).toBeNull();
    expect(toEmbedPermalink(null)).toBeNull();
  });
});

describe("instagramShortcode", () => {
  it("p/reel/tv에서 shortcode 추출(폼 무관)", () => {
    expect(instagramShortcode("https://www.instagram.com/p/DaKWpO-k9Ha/")).toBe("DaKWpO-k9Ha");
    expect(instagramShortcode("https://instagram.com/reel/DEF456/?igsh=x")).toBe("DEF456");
    expect(instagramShortcode("https://www.instagram.com/tv/ABC123")).toBe("ABC123");
  });
  it("동일 shortcode는 p/reel 폼이 달라도 같은 값", () => {
    expect(instagramShortcode("https://www.instagram.com/p/XYZ/")).toBe(
      instagramShortcode("https://www.instagram.com/reel/XYZ/"),
    );
  });
  it("프로필/비IG/무효는 null", () => {
    expect(instagramShortcode("https://www.instagram.com/someuser/")).toBeNull();
    expect(instagramShortcode("https://youtube.com/watch?v=x")).toBeNull();
    expect(instagramShortcode(null)).toBeNull();
  });
});
