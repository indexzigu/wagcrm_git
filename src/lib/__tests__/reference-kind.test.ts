import { describe, expect, it } from "vitest";
import {
  classifyInstagramUrl,
  extractInstagramUsername,
  formatKoreanCount,
  formatRelativeKo,
} from "../reference-kind";
import { mapRapidApiUserInfo } from "../reference-enrich";

describe("classifyInstagramUrl", () => {
  it("게시물 permalink 4형(p/reel/reels/tv)을 POST로 분류한다", () => {
    expect(classifyInstagramUrl("https://www.instagram.com/p/DEF456/")).toBe("POST");
    expect(classifyInstagramUrl("https://instagram.com/reel/ABC-_123")).toBe("POST");
    expect(classifyInstagramUrl("https://www.instagram.com/reels/XyZ987/")).toBe("POST");
    expect(classifyInstagramUrl("https://www.instagram.com/tv/QQQ111/")).toBe("POST");
  });

  it("계정 루트 URL을 PROFILE로 분류한다(언더스코어·마침표 계정명 포함)", () => {
    expect(classifyInstagramUrl("https://www.instagram.com/haon_shop/")).toBe("PROFILE");
    expect(classifyInstagramUrl("https://instagram.com/danji.table")).toBe("PROFILE");
  });

  it("계정 하위 탭 tagged/saved도 PROFILE로 본다", () => {
    expect(classifyInstagramUrl("https://www.instagram.com/somang.haus/tagged/")).toBe("PROFILE");
    expect(classifyInstagramUrl("https://www.instagram.com/somang.haus/saved")).toBe("PROFILE");
  });

  it("계정 릴스 탭을 PROFILE_REELS로 분류한다", () => {
    expect(classifyInstagramUrl("https://www.instagram.com/haon_shop/reels")).toBe(
      "PROFILE_REELS",
    );
    expect(classifyInstagramUrl("https://www.instagram.com/haon_shop/reels/")).toBe(
      "PROFILE_REELS",
    );
  });

  it("예약 경로·판별 불가 URL은 null", () => {
    // shortcode 없는 게시물 경로
    expect(classifyInstagramUrl("https://www.instagram.com/reels/")).toBeNull();
    // 시스템 경로는 계정명이 아니다
    expect(classifyInstagramUrl("https://www.instagram.com/explore/")).toBeNull();
    expect(classifyInstagramUrl("https://www.instagram.com/stories/someone/123/")).toBeNull();
    expect(classifyInstagramUrl("https://www.instagram.com/accounts/login/")).toBeNull();
    // 계정명 규칙 위반(한글 등)
    expect(classifyInstagramUrl("https://www.instagram.com/한글계정/")).toBeNull();
    // 3세그먼트 이상 알 수 없는 형태
    expect(classifyInstagramUrl("https://www.instagram.com/user/reels/extra/")).toBeNull();
  });

  it("비인스타 호스트·비http·파싱 불가는 null", () => {
    expect(classifyInstagramUrl("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(classifyInstagramUrl("instagram://user?username=x")).toBeNull();
    expect(classifyInstagramUrl("not a url")).toBeNull();
  });
});

describe("extractInstagramUsername", () => {
  it("PROFILE/PROFILE_REELS에서 계정명을 추출한다", () => {
    expect(extractInstagramUsername("https://www.instagram.com/haon_shop/")).toBe("haon_shop");
    expect(extractInstagramUsername("https://www.instagram.com/danji.table/reels")).toBe(
      "danji.table",
    );
  });

  it("POST·판별 불가 URL은 null", () => {
    expect(extractInstagramUsername("https://www.instagram.com/p/DEF456/")).toBeNull();
    expect(extractInstagramUsername("https://www.instagram.com/explore/")).toBeNull();
  });
});

describe("formatKoreanCount", () => {
  it("1만 이상은 N.N만(트레일링 0 제거)", () => {
    expect(formatKoreanCount(84_000)).toBe("8.4만");
    expect(formatKoreanCount(32_000)).toBe("3.2만");
    expect(formatKoreanCount(120_000)).toBe("12만");
    expect(formatKoreanCount(10_000)).toBe("1만");
  });

  it("100만 이상은 정수 만 단위", () => {
    expect(formatKoreanCount(1_234_000)).toBe("123만");
  });

  it("1만 미만은 천단위 구분 원수", () => {
    expect(formatKoreanCount(9_800)).toBe("9,800");
    expect(formatKoreanCount(412)).toBe("412");
    expect(formatKoreanCount(0)).toBe("0");
  });

  it("음수·비정상 입력은 0", () => {
    expect(formatKoreanCount(-5)).toBe("0");
    expect(formatKoreanCount(Number.NaN)).toBe("0");
  });
});

describe("formatRelativeKo", () => {
  const now = new Date("2026-07-10T12:00:00Z");

  it("분/시간/일/개월 단위 상대 표기", () => {
    expect(formatRelativeKo("2026-07-10T11:59:40Z", now)).toBe("방금 전");
    expect(formatRelativeKo("2026-07-10T11:30:00Z", now)).toBe("30분 전");
    expect(formatRelativeKo("2026-07-10T07:00:00Z", now)).toBe("5시간 전");
    expect(formatRelativeKo("2026-07-08T12:00:00Z", now)).toBe("2일 전");
    expect(formatRelativeKo("2026-05-01T12:00:00Z", now)).toBe("2개월 전");
    expect(formatRelativeKo("2024-06-01T12:00:00Z", now)).toBe("2년 전");
  });

  it("미래 시각은 방금 전, 파싱 불가는 빈 문자열", () => {
    expect(formatRelativeKo("2026-07-11T00:00:00Z", now)).toBe("방금 전");
    expect(formatRelativeKo("not-a-date", now)).toBe("");
  });
});

describe("mapRapidApiUserInfo", () => {
  const flat = {
    username: "haon_shop",
    full_name: "애엥의 기록",
    biography: "일상과 육아 사이 어딘가",
    follower_count: 32_000,
    media_count: 412,
    profile_pic_url: "https://cdn.example.com/pic.jpg",
    hd_profile_pic_url_info: { url: "https://cdn.example.com/pic_hd.jpg" },
  };

  it("평면 객체를 매핑하고 hd 프로필 사진을 우선한다", () => {
    expect(mapRapidApiUserInfo(flat)).toEqual({
      username: "haon_shop",
      fullName: "애엥의 기록",
      bio: "일상과 육아 사이 어딘가",
      followerCount: 32_000,
      postCount: 412,
      profilePicUrl: "https://cdn.example.com/pic_hd.jpg",
    });
  });

  it("배열 응답은 username 있는 첫 요소를 쓴다(scraper.ts 관용 unwrap)", () => {
    expect(mapRapidApiUserInfo([null, flat]).username).toBe("haon_shop");
  });

  it("data 래핑 응답을 벗겨낸다", () => {
    expect(mapRapidApiUserInfo({ data: flat }).username).toBe("haon_shop");
  });

  it("hd 사진이 없으면 profile_pic_url로 폴백", () => {
    const noHd = { ...flat, hd_profile_pic_url_info: null };
    expect(mapRapidApiUserInfo(noHd).profilePicUrl).toBe("https://cdn.example.com/pic.jpg");
  });

  it("비정상 입력은 전 필드 null", () => {
    expect(mapRapidApiUserInfo(null)).toEqual({
      username: null,
      fullName: null,
      bio: null,
      followerCount: null,
      postCount: null,
      profilePicUrl: null,
    });
  });
});
