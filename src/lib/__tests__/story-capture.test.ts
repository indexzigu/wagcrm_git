import { describe, expect, it } from "vitest";
import {
  parseStoryItems,
  isWithinCaptureWindow,
  normalizeHandle,
  startOfKstDay,
  STORY_CAPTURE_PREROLL_DAYS,
  STORY_CAPTURE_TRAIL_DAYS,
} from "../story-capture";

// RapidAPI instagram-scraper-20251 /userstories/ 실응답 포맷(2026-07-10 실측):
// id(pk 아님)·thumbnail_url·image_versions.items·video_versions·user.username.
const rapidPhotoStory = {
  id: "3937353043310210374",
  taken_at: 1783990800, // epoch sec
  expiring_at: 1784077200,
  media_type: 1,
  thumbnail_url: "https://cdn.example.com/thumb.jpg",
  image_versions: { items: [{ url: "https://cdn.example.com/full.jpg" }] },
  caption: null,
  user: { username: "gaon", full_name: "김본명" },
};

const rapidVideoStory = {
  id: "3937358655662531429",
  taken_at: 1783994400,
  expiring_at: 1784080800,
  media_type: 2,
  thumbnail_url: "https://cdn.example.com/poster.jpg",
  video_versions: [{ url: "https://cdn.example.com/video.mp4" }],
  video_url: "https://cdn.example.com/video-alt.mp4",
  caption: { text: "오늘 마지막 공구!" },
  user: { username: "nari_c" },
};

// storiesig.info 뷰어 실응답 포맷(2026-07-10 실측) — pk·image_versions2.candidates·user.username,
// **media_type/expiring_at 미제공**. 영상은 video_versions 로만 판별해야 한다.
const viewerPhotoStory = {
  pk: "3387001122334455",
  taken_at: 1783990800,
  image_versions2: { candidates: [{ url: "https://cdn.example.com/std.jpg" }] },
  user: { username: "gaon" },
};
const viewerVideoStory = {
  pk: "3387009988776655",
  taken_at: 1783990800,
  image_versions2: { candidates: [{ url: "https://cdn.example.com/vposter.jpg" }] },
  video_versions: [{ url: "https://cdn.example.com/v.mp4" }],
  user: { username: "gaon" },
};

describe("parseStoryItems", () => {
  it("RapidAPI 포맷(id·thumbnail_url·image_versions.items·video_versions)을 정규화한다", () => {
    const out = parseStoryItems([rapidPhotoStory, rapidVideoStory]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      username: "gaon",
      storyPk: "3937353043310210374",
      mediaType: 1,
      imageUrl: "https://cdn.example.com/thumb.jpg", // thumbnail_url 우선
      videoUrl: null,
    });
    expect(out[0].takenAtMs).toBe(1783990800 * 1000);
    expect(out[1]).toMatchObject({
      username: "nari_c",
      mediaType: 2,
      imageUrl: "https://cdn.example.com/poster.jpg",
      videoUrl: "https://cdn.example.com/video.mp4", // video_versions[0] 우선
      caption: "오늘 마지막 공구!",
    });
  });

  it("뷰어 포맷(pk·image_versions2)도 정규화하고, media_type 없이 video_versions로 영상 판별한다", () => {
    const out = parseStoryItems([viewerPhotoStory, viewerVideoStory]);
    expect(out[0]).toMatchObject({
      storyPk: "3387001122334455",
      imageUrl: "https://cdn.example.com/std.jpg",
      mediaType: 1, // media_type 없음 + video 없음 → 사진
      videoUrl: null,
    });
    expect(out[1]).toMatchObject({
      storyPk: "3387009988776655",
      mediaType: 2, // media_type 없어도 video_versions 있으면 영상
      videoUrl: "https://cdn.example.com/v.mp4",
    });
  });

  it("expiring_at 미제공 시 게시 24시간 후로 만료 시각을 계산한다(스토리 수명 고정)", () => {
    const [a] = parseStoryItems([viewerPhotoStory]);
    expect(a.expiringAtMs).toBe(1783990800 * 1000 + 24 * 60 * 60 * 1000);
  });

  it("thumbnail_url 없으면 image_versions.items → image_versions2.candidates 순 폴백", () => {
    const [a] = parseStoryItems([{ ...rapidPhotoStory, thumbnail_url: undefined }]);
    expect(a.imageUrl).toBe("https://cdn.example.com/full.jpg");
  });

  it("식별자(username·id/pk) 또는 taken_at 결손 항목만 제외하고 나머지 필드 결손은 null 보존", () => {
    const out = parseStoryItems([
      { ...rapidPhotoStory, user: {} }, // username 없음 → 제외
      { ...rapidPhotoStory, id: undefined }, // 식별자 없음 → 제외
      { ...rapidPhotoStory, taken_at: undefined }, // 시각 없음 → 제외
      { ...rapidPhotoStory, thumbnail_url: undefined, image_versions: undefined }, // 이미지 결손 → 포함
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].imageUrl).toBeNull();
  });

  it("배열이 아니거나(에러 응답 등) 비정상 항목이면 빈 결과", () => {
    expect(parseStoryItems({ message: "Too many requests" })).toEqual([]);
    expect(parseStoryItems(null)).toEqual([]);
    expect(parseStoryItems([null, 42, "x"])).toEqual([]);
  });
});

describe("isWithinCaptureWindow", () => {
  const start = new Date("2026-07-12T00:00:00+09:00");
  const end = new Date("2026-07-19T23:59:59+09:00");

  it(`시작 ${STORY_CAPTURE_PREROLL_DAYS}일 전(사전 홍보)부터 마감 ${STORY_CAPTURE_TRAIL_DAYS}일 후까지 수집`, () => {
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-05T06:00:00+09:00"))).toBe(true); // 프리롤 시작(시작 7일 전)
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-10T01:00:00+09:00"))).toBe(true); // 프리롤 중
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-15T12:00:00+09:00"))).toBe(true); // 기간 중
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-20T18:00:00+09:00"))).toBe(true); // 마감 1일 후(트레일)
  });

  it("프리롤 이전·트레일 이후는 수집하지 않는다", () => {
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-04T12:00:00+09:00"))).toBe(false); // 시작 7일 전보다 이전
    expect(isWithinCaptureWindow(start, end, new Date("2026-07-21T09:00:00+09:00"))).toBe(false); // 마감 1일 후보다 이후
  });
});

describe("startOfKstDay (일일 수집 게이트 하한)", () => {
  it("KST 자정을 UTC로 환산한다(= 전날 15:00Z)", () => {
    // 2026-07-13 KST 자정 = 2026-07-12T15:00:00Z
    expect(startOfKstDay(new Date("2026-07-13T09:30:00+09:00")).toISOString()).toBe(
      "2026-07-12T15:00:00.000Z",
    );
  });

  it("KST 당일 어느 시각이든 같은 자정으로 내림한다(경계 포함)", () => {
    const a = startOfKstDay(new Date("2026-07-13T00:00:00+09:00"));
    const b = startOfKstDay(new Date("2026-07-13T23:59:59+09:00"));
    expect(a.toISOString()).toBe("2026-07-12T15:00:00.000Z");
    expect(b.toISOString()).toBe("2026-07-12T15:00:00.000Z");
  });

  it("UTC 자정 직후(=KST 오전 9시)는 같은 KST 날짜로 묶인다", () => {
    // 2026-07-13T00:30:00Z = KST 09:30 → KST 자정은 2026-07-12T15:00Z
    expect(startOfKstDay(new Date("2026-07-13T00:30:00Z")).toISOString()).toBe(
      "2026-07-12T15:00:00.000Z",
    );
  });
});

describe("normalizeHandle", () => {
  it("@·공백·대문자를 정규화한다 (액터 응답 매칭 키)", () => {
    expect(normalizeHandle("@Gaon ")).toBe("gaon");
    expect(normalizeHandle("nari_c")).toBe("nari_c");
  });
});
