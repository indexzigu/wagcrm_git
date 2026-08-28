import { describe, it, expect } from "vitest";
import { mergePostsPreview } from "../posts-preview-merge";
import type { PostPreview } from "../types";

function p(permalink: string | null, extra: Partial<PostPreview> = {}): PostPreview {
  return { permalink, taken_at: null, likes: 0, comments: 0, ...extra } as PostPreview;
}

describe("mergePostsPreview", () => {
  it("fresh 우선 + fresh에 없는 이전 항목을 뒤에 보존", () => {
    const fresh = [p("a"), p("b")];
    const existing = [p("b"), p("c"), p("d")];
    const out = mergePostsPreview(fresh, existing, 10);
    expect(out.map((x) => x.permalink)).toEqual(["a", "b", "c", "d"]);
  });

  it("동일 permalink는 fresh 값으로 대체(이전 값 버림)", () => {
    const fresh = [p("a", { likes: 100 })];
    const existing = [p("a", { likes: 1 })];
    const out = mergePostsPreview(fresh, existing, 10);
    expect(out).toHaveLength(1);
    expect(out[0].likes).toBe(100);
  });

  it("cap을 넘지 않는다(fresh가 cap을 채우면 이전 항목 미보존)", () => {
    const fresh = [p("a"), p("b"), p("c")];
    const existing = [p("d"), p("e")];
    const out = mergePostsPreview(fresh, existing, 3);
    expect(out.map((x) => x.permalink)).toEqual(["a", "b", "c"]);
  });

  it("cap 여유만큼만 이전 항목 보존", () => {
    const fresh = [p("a"), p("b")];
    const existing = [p("c"), p("d"), p("e")];
    const out = mergePostsPreview(fresh, existing, 3);
    expect(out.map((x) => x.permalink)).toEqual(["a", "b", "c"]);
  });

  it("permalink 없는 이전 항목은 dedup 불가라 건너뜀(fresh의 null은 통과)", () => {
    const fresh = [p(null), p("a")];
    const existing = [p(null), p("b")];
    const out = mergePostsPreview(fresh, existing, 10);
    expect(out.map((x) => x.permalink)).toEqual([null, "a", "b"]);
  });

  // 안정(shortcode 키) 재호스팅 썸네일 보존 계약 — 2026-07-16 오염 실사고의 회귀 가드.
  describe("thumb 보존", () => {
    const PERMALINK = "https://www.instagram.com/p/ABC123/";
    const STABLE_THUMB =
      "https://x.supabase.co/storage/v1/object/public/seller-media/sellers/s1/ABC123.webp";
    const LEGACY_IDX_THUMB =
      "https://x.supabase.co/storage/v1/object/public/seller-media/sellers/s1/3.webp";
    const FRESH_FBCDN = "https://scontent.cdninstagram.com/v/fresh.jpg";

    it("동일 permalink의 existing thumb이 안정(shortcode 키) 재호스팅 URL이면 fresh 대신 보존", () => {
      const fresh = [p(PERMALINK, { thumb: FRESH_FBCDN, likes: 100 })];
      const existing = [p(PERMALINK, { thumb: STABLE_THUMB, likes: 1 })];
      const out = mergePostsPreview(fresh, existing, 10);
      expect(out).toHaveLength(1);
      expect(out[0].thumb).toBe(STABLE_THUMB); // 썸네일만 보존
      expect(out[0].likes).toBe(100); // 지표는 fresh 우선 유지
    });

    it("레거시 인덱스 키 재호스팅 URL은 보존하지 않음(내용물 오염 가능 — fresh로 대체)", () => {
      const fresh = [p(PERMALINK, { thumb: FRESH_FBCDN })];
      const existing = [p(PERMALINK, { thumb: LEGACY_IDX_THUMB })];
      const out = mergePostsPreview(fresh, existing, 10);
      expect(out[0].thumb).toBe(FRESH_FBCDN);
    });

    it("fresh에 없는 이전 항목은 thumb 그대로 뒤에 보존(기존 동작 불변)", () => {
      const fresh = [p("https://www.instagram.com/p/NEW1/", { thumb: FRESH_FBCDN })];
      const existing = [p(PERMALINK, { thumb: STABLE_THUMB })];
      const out = mergePostsPreview(fresh, existing, 10);
      expect(out).toHaveLength(2);
      expect(out[1].thumb).toBe(STABLE_THUMB);
    });

    it("보존되는 이전 항목의 레거시 인덱스 키 thumb은 null로 끊는다(오염 이어나르기 방지)", () => {
      const fresh = [p("https://www.instagram.com/p/NEW1/", { thumb: FRESH_FBCDN })];
      const existing = [p(PERMALINK, { thumb: LEGACY_IDX_THUMB })];
      const out = mergePostsPreview(fresh, existing, 10);
      expect(out).toHaveLength(2);
      expect(out[1].thumb).toBeNull();
    });

    it("보존되는 이전 항목의 fbcdn thumb은 그대로 둔다(버킷 URL만 신원 검증 대상)", () => {
      const fresh = [p("https://www.instagram.com/p/NEW1/", { thumb: FRESH_FBCDN })];
      const existing = [p(PERMALINK, { thumb: "https://scontent.cdninstagram.com/v/old.jpg" })];
      const out = mergePostsPreview(fresh, existing, 10);
      expect(out[1].thumb).toBe("https://scontent.cdninstagram.com/v/old.jpg");
    });
  });
});
