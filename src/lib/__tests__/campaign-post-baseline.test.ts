import { describe, it, expect } from "vitest";
import {
  BASELINE_MIN_SAMPLE,
  baselineBasisLine,
  baselineUnavailableLine,
  campaignVsBaseline,
  computeLikesBaseline,
  extractBaselineSample,
  formatBaselineMultiple,
  isInstagramLikeUrl,
  postVsBaseline,
  type BaselineExclusion,
  type BaselineSample,
} from "../campaign-post-baseline";

const NONE: BaselineExclusion = { ownShortcodes: new Set<string>() };
const IG = "https://www.instagram.com/p/X/";

type Spec = number | "hidden" | { likes: number | "hidden"; sc?: string; at?: string };

function sample(specs: Spec[]): BaselineSample {
  return {
    analyzed: true,
    posts: specs.map((raw, i) => {
      const s = typeof raw === "object" ? raw : { likes: raw };
      const hidden = s.likes === "hidden";
      return {
        shortcode: s.sc ?? `sc${i}`,
        likes: hidden ? null : (s.likes as number),
        hidden,
        takenAt: s.at ?? null,
      };
    }),
  };
}

describe("extractBaselineSample", () => {
  it("returns not-analyzed for missing or empty preview", () => {
    expect(extractBaselineSample(null)).toEqual({ analyzed: false, posts: [] });
    expect(extractBaselineSample({})).toEqual({ analyzed: false, posts: [] });
    expect(extractBaselineSample({ postsPreview: [] })).toEqual({ analyzed: false, posts: [] });
  });

  it("parses shortcode and taken_at, keeps hidden posts as hidden (likes null)", () => {
    const out = extractBaselineSample({
      postsPreview: [
        { permalink: "https://www.instagram.com/p/AAA/", likes: 120, taken_at: "2030-01-02T00:00:00.000Z" },
        { permalink: "https://www.instagram.com/p/BBB/", likes: 0, likes_hidden: true, taken_at: "bogus" },
        { permalink: "https://instagram.example.com/p/demo/", likes: 50 },
      ],
    });
    expect(out.analyzed).toBe(true);
    expect(out.posts).toEqual([
      { shortcode: "AAA", likes: 120, hidden: false, takenAt: "2030-01-02T00:00:00.000Z" },
      { shortcode: "BBB", likes: null, hidden: true, takenAt: null },
      // 파싱 불가 URL 도 표본에는 남는다(자기 제외 대조만 못 한다)
      { shortcode: null, likes: 50, hidden: false, takenAt: null },
    ]);
  });

  it("drops malformed entries instead of filling 0", () => {
    const out = extractBaselineSample({
      postsPreview: [null, "x", { likes: "12" }, { likes: Number.NaN }, { likes: -3 }, { likes: 7 }],
    });
    expect(out.posts).toEqual([{ shortcode: null, likes: 7, hidden: false, takenAt: null }]);
  });
});

describe("computeLikesBaseline", () => {
  it("takes the middle value of odd and even samples", () => {
    expect(computeLikesBaseline(sample([5, 1, 3, 9, 7]), NONE)).toMatchObject({ ok: true, medianLikes: 5, sampleSize: 5 });
    expect(computeLikesBaseline(sample([1, 2, 3, 4, 5, 6]), NONE)).toMatchObject({ ok: true, medianLikes: 3.5, sampleSize: 6 });
  });

  it("excludes the campaign's own registered posts", () => {
    const s = sample([100, 100, 100, 100, 100, { likes: 5000, sc: "mine" }]);
    expect(computeLikesBaseline(s, { ownShortcodes: new Set(["mine"]) })).toMatchObject({
      ok: true,
      medianLikes: 100,
      sampleSize: 5,
    });
  });

  it("excludes every post inside the campaign window [start-7d, end+1d], registered or not", () => {
    const ex: BaselineExclusion = { ownShortcodes: new Set(), startDate: "2030-03-10", endDate: "2030-03-20" };
    const s = sample([
      { likes: 100, at: "2030-01-01T00:00:00.000Z" },
      { likes: 100, at: "2030-02-01T00:00:00.000Z" },
      { likes: 100, at: "2030-03-02T00:00:00.000Z" }, // 시작−8일: 기간 밖(평소)
      { likes: 9000, at: "2030-03-04T00:00:00.000Z" }, // 시작−6일: 미검토 후보 — 기간 안
      { likes: 9000, at: "2030-03-21T12:00:00.000Z" }, // 마감 다음날: 기간 안
      { likes: 100, at: "2030-03-23T00:00:00.000Z" }, // 마감+3일: 평소
      { likes: 100, at: "2030-05-01T00:00:00.000Z" },
      { likes: 100 }, // 시각 미상: 평소로 둔다
    ]);
    const r = computeLikesBaseline(s, ex);
    expect(r).toMatchObject({ ok: true, medianLikes: 100, sampleSize: 6 });
  });

  it("opens the window at KST midnight of start-7d, not UTC midnight (9h earlier)", () => {
    // 시작 3.10 → 창 시작 = 3.3 00:00 KST = 3.2 15:00Z. UTC 자정으로 읽으면 3.3 00:00Z 라 아래 글이 새어 든다.
    const ex: BaselineExclusion = { ownShortcodes: new Set(), startDate: "2030-03-10", endDate: "2030-03-20" };
    const inside = { likes: 9000, at: "2030-03-02T16:00:00.000Z" }; // KST 3.3 01:00 — 기간 안
    const outside = { likes: 100, at: "2030-03-02T14:00:00.000Z" }; // KST 3.2 23:00 — 평소
    const s = sample([100, 100, 100, 100, outside, inside]);
    expect(computeLikesBaseline(s, ex)).toMatchObject({ ok: true, medianLikes: 100, sampleSize: 5 });
    // UTC 자정 ISO 로 와도 같은 달력 날짜로 읽는다.
    const iso = { ...ex, startDate: "2030-03-10T00:00:00.000Z", endDate: "2030-03-20T00:00:00.000Z" };
    expect(computeLikesBaseline(s, iso)).toMatchObject({ ok: true, sampleSize: 5 });
  });

  it("excludes hidden and zero-like posts (zero is indistinguishable from hidden on non-Graph tiers)", () => {
    const s = sample([200, 200, 200, 200, 200, "hidden", "hidden", 0, 0, 0, 0, 0, 0]);
    expect(computeLikesBaseline(s, NONE)).toMatchObject({ ok: true, medianLikes: 200, sampleSize: 5 });
  });

  it("reports TOO_FEW below the minimum sample with the counted size", () => {
    expect(computeLikesBaseline(sample([10, 20, 30, 40]), NONE)).toEqual({ ok: false, reason: "TOO_FEW", sampleSize: 4 });
    expect(BASELINE_MIN_SAMPLE).toBe(5);
  });

  it("reports ALL_HIDDEN when no remaining post shows a positive like count", () => {
    expect(computeLikesBaseline(sample(["hidden", 0, "hidden"]), NONE)).toEqual({
      ok: false,
      reason: "ALL_HIDDEN",
      sampleSize: 0,
    });
  });

  it("reports NOT_ANALYZED and LOAD_FAILED", () => {
    expect(computeLikesBaseline({ analyzed: false, posts: [] }, NONE)).toMatchObject({ ok: false, reason: "NOT_ANALYZED" });
    expect(computeLikesBaseline(null, NONE)).toMatchObject({ ok: false, reason: "LOAD_FAILED" });
  });
});

describe("multiples / formatting", () => {
  const base = computeLikesBaseline(sample([100, 100, 100, 100, 100]), NONE);

  it("divides post likes by the baseline for Instagram posts only", () => {
    expect(postVsBaseline(180, base, IG)).toBeCloseTo(1.8);
    expect(postVsBaseline(0, base, IG)).toBe(0);
    expect(postVsBaseline(180, base, "https://youtu.be/abc")).toBeNull();
    expect(isInstagramLikeUrl("https://instagram.example.com/p/d/")).toBe(true);
    expect(isInstagramLikeUrl("not a url")).toBe(false);
  });

  it("returns null for hidden/uncollected likes or unavailable baseline (no fake number)", () => {
    expect(postVsBaseline(null, base, IG)).toBeNull();
    expect(postVsBaseline(180, computeLikesBaseline(null, NONE), IG)).toBeNull();
  });

  it("summarises the campaign by the middle value, not the mean (one viral post does not drive it)", () => {
    const r = campaignVsBaseline(
      [
        { likes: 80, externalUrl: IG },
        { likes: 90, externalUrl: IG },
        { likes: 2000, externalUrl: IG },
        { likes: null, externalUrl: IG },
        { likes: 5000, externalUrl: "https://youtu.be/abc" },
      ],
      base,
    );
    expect(r).toEqual({ multiple: 0.9, postCount: 3 });
    expect(campaignVsBaseline([{ likes: null, externalUrl: IG }], base)).toBeNull();
  });

  it("formats multiples with the 배 suffix", () => {
    expect(formatBaselineMultiple(1.84)).toBe("1.8배");
    expect(formatBaselineMultiple(0.6)).toBe("0.6배");
    expect(formatBaselineMultiple(12.4)).toBe("12배");
  });

  it("speaks a basis line with the sample period when available, and a reason line otherwise", () => {
    expect(baselineBasisLine(base)).toBe("평소 좋아요 100 · 게시물 5개");
    const dated = computeLikesBaseline(
      sample([1, 2, 3, 4, 5].map((n) => ({ likes: 100, at: `2030-0${n}-15T03:00:00.000Z` }))),
      NONE,
    );
    expect(baselineBasisLine(dated)).toBe("평소 좋아요 100 · 게시물 5개 (1.15~5.15)");
    expect(baselineUnavailableLine(base)).toBeNull();
    expect(baselineUnavailableLine({ ok: false, reason: "TOO_FEW", sampleSize: 3 })).toBe("평소 게시물 3개 · 5개부터 계산");
    expect(baselineUnavailableLine({ ok: false, reason: "NOT_ANALYZED", sampleSize: 0 })).toBe("셀러 분석 전");
    expect(baselineUnavailableLine({ ok: false, reason: "ALL_HIDDEN", sampleSize: 0 })).toBe("평소 좋아요 비공개");
    expect(baselineUnavailableLine({ ok: false, reason: "LOAD_FAILED", sampleSize: 0 })).toBe("평소 수치를 불러오지 못함");
    expect(baselineBasisLine({ ok: false, reason: "LOAD_FAILED", sampleSize: 0 })).toBeNull();
  });
});
