// mediaRehost 저장 키 계약 — 썸네일 저장 키는 게시물 신원(shortcode)이어야 한다.
// 배열 인덱스 키는 일간 수집의 인덱스 드리프트마다 같은 URL이 다른 게시물 이미지로 덮여,
// 등록(Asset) 복사본 다수가 오염된 실사고(2026-07-16)의 회귀 가드다.
import { describe, it, expect } from "vitest";
import { isStablePostThumb, postThumbBasename } from "../mediaRehost";

const BUCKET_BASE = "https://x.supabase.co/storage/v1/object/public/seller-media";

describe("postThumbBasename", () => {
  it("p/reel/tv permalink에서 shortcode를 뽑는다", () => {
    expect(postThumbBasename("https://www.instagram.com/p/ABC123/")).toBe("ABC123");
    expect(postThumbBasename("https://www.instagram.com/reel/DEF_45-6/")).toBe("DEF_45-6");
    expect(postThumbBasename("https://www.instagram.com/tv/GHI789/")).toBe("GHI789");
  });

  it("permalink가 없거나 IG 게시물 형태가 아니면 null(저장 키 없음 = 재호스팅 제외)", () => {
    expect(postThumbBasename(null)).toBeNull();
    expect(postThumbBasename(undefined)).toBeNull();
    expect(postThumbBasename("https://example.com/p/ABC/")).toBeNull();
    expect(postThumbBasename("https://www.instagram.com/stories/user/123/")).toBeNull();
  });
});

describe("isStablePostThumb", () => {
  const PERMALINK = "https://www.instagram.com/p/ABC123/";

  it("자기 shortcode 키의 버킷 URL만 안정으로 판정", () => {
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/ABC123.webp`, PERMALINK)).toBe(true);
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/ABC123.jpg`, PERMALINK)).toBe(true);
  });

  it("레거시 인덱스 키(숫자 basename)는 불안정 — 보존 금지", () => {
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/0.webp`, PERMALINK)).toBe(false);
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/11.jpg`, PERMALINK)).toBe(false);
  });

  it("다른 게시물 shortcode 키·버킷 밖 URL·결측은 전부 불안정", () => {
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/OTHER99.webp`, PERMALINK)).toBe(false);
    expect(isStablePostThumb("https://scontent.cdninstagram.com/v/x.jpg", PERMALINK)).toBe(false);
    expect(isStablePostThumb(null, PERMALINK)).toBe(false);
    expect(isStablePostThumb(`${BUCKET_BASE}/sellers/s1/ABC123.webp`, null)).toBe(false);
  });
});
