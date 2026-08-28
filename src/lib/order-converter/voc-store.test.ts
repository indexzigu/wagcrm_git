import { describe, it, expect } from "vitest";
import {
  mergeReviews,
  computeVocAggregate,
  normalizeImportedReviews,
  type VocReview,
} from "./voc-store";

const review = (o: Partial<VocReview> & { externalId: string }): VocReview => ({
  rating: 5,
  content: "좋아요",
  writtenAt: "2026-07-01T00:00:00Z",
  ...o,
});

describe("mergeReviews", () => {
  it("externalId로 dedup하고 신규가 기존을 갱신한다", () => {
    const existing = [review({ externalId: "r1", rating: 3, content: "old" })];
    const incoming = [review({ externalId: "r1", rating: 3, content: "답변 반영" }), review({ externalId: "r2" })];
    const merged = mergeReviews(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.externalId === "r1")?.content).toBe("답변 반영"); // 신규 우선
  });

  it("writtenAt 내림차순 정렬(최신 우선)", () => {
    const merged = mergeReviews(
      [],
      [
        review({ externalId: "old", writtenAt: "2026-01-01T00:00:00Z" }),
        review({ externalId: "new", writtenAt: "2026-07-01T00:00:00Z" }),
        review({ externalId: "mid", writtenAt: "2026-04-01T00:00:00Z" }),
      ],
    );
    expect(merged.map((r) => r.externalId)).toEqual(["new", "mid", "old"]);
  });

  it("externalId 빈 항목은 버린다(무한 증식 방지)", () => {
    const merged = mergeReviews([], [review({ externalId: "" }), review({ externalId: "  " }), review({ externalId: "ok" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].externalId).toBe("ok");
  });

  it("재수집(같은 입력)은 코퍼스를 늘리지 않는다(멱등)", () => {
    const first = mergeReviews([], [review({ externalId: "a" }), review({ externalId: "b" })]);
    const second = mergeReviews(first, [review({ externalId: "a" }), review({ externalId: "b" })]);
    expect(second).toHaveLength(2);
  });
});

describe("computeVocAggregate", () => {
  it("평점 분포·합·평균 근거를 집계한다", () => {
    const agg = computeVocAggregate([
      review({ externalId: "a", rating: 5 }),
      review({ externalId: "b", rating: 5 }),
      review({ externalId: "c", rating: 3 }),
    ]);
    expect(agg.reviewCount).toBe(3);
    expect(agg.ratingSum).toBe(13);
    expect(agg.ratingCounts["5"]).toBe(2);
    expect(agg.ratingCounts["3"]).toBe(1);
    expect(agg.ratingSum / agg.reviewCount).toBeCloseTo(4.33, 1);
  });

  it("범위 밖 평점은 분포·합에서 제외한다", () => {
    const agg = computeVocAggregate([review({ externalId: "a", rating: 0 }), review({ externalId: "b", rating: 6 })]);
    expect(agg.ratingSum).toBe(0);
    expect(Object.values(agg.ratingCounts).reduce((s, n) => s + n, 0)).toBe(0);
    expect(agg.reviewCount).toBe(2); // 개수 자체는 전체
  });

  it("포토리뷰(imageUrls 있음)만 photoCount", () => {
    const agg = computeVocAggregate([
      review({ externalId: "a", imageUrls: ["u1"] }),
      review({ externalId: "b", imageUrls: [] }),
      review({ externalId: "c" }),
    ]);
    expect(agg.photoCount).toBe(1);
  });

  it("latestReviewAt은 최신 작성일", () => {
    const agg = computeVocAggregate([
      review({ externalId: "a", writtenAt: "2026-01-01T00:00:00Z" }),
      review({ externalId: "b", writtenAt: "2026-07-15T00:00:00Z" }),
    ]);
    expect(agg.latestReviewAt?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("preview는 최신 10건으로 제한", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      review({ externalId: `r${i}`, writtenAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const merged = mergeReviews([], many);
    const agg = computeVocAggregate(merged);
    expect(agg.preview).toHaveLength(10);
    expect(agg.preview[0].externalId).toBe("r14"); // 최신
  });

  it("빈 코퍼스는 0 집계·latest null", () => {
    const agg = computeVocAggregate([]);
    expect(agg.reviewCount).toBe(0);
    expect(agg.ratingSum).toBe(0);
    expect(agg.latestReviewAt).toBeNull();
    expect(agg.preview).toEqual([]);
  });
});

describe("normalizeImportedReviews", () => {
  it("유효 리뷰를 정규화하고 rating 범위 밖·빈 content·잘못된 날짜는 버린다", () => {
    const out = normalizeImportedReviews([
      { rating: 5, content: "좋아요", writtenAt: "2026-07-01" },
      { rating: 6, content: "범위밖", writtenAt: "2026-07-01" }, // 버림
      { rating: 4, content: "   ", writtenAt: "2026-07-01" }, // 빈 content 버림
      { rating: 4, content: "날짜없음" }, // writtenAt 없음 버림
      { rating: 3, content: "잘못된날짜", writtenAt: "not-a-date" }, // 버림
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rating: 5, content: "좋아요" });
    expect(out[0].writtenAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("externalId 없으면 내용 해시로 채우고, 같은 내용은 같은 id(재임포트 멱등)", () => {
    const a = normalizeImportedReviews([{ rating: 5, content: "동일", writtenAt: "2026-07-01" }]);
    const b = normalizeImportedReviews([{ rating: 5, content: "동일", writtenAt: "2026-07-01" }]);
    expect(a[0].externalId).toBe(b[0].externalId);
    expect(a[0].externalId).toMatch(/^h_[0-9a-f]{16}$/);
  });

  it("writtenAt이 epoch 숫자(ms)여도 통과한다(코드리뷰 HIGH — String 캐스팅 유실 방지)", () => {
    const epoch = Date.parse("2026-07-01T00:00:00Z");
    const out = normalizeImportedReviews([{ rating: 5, content: "epoch", writtenAt: epoch }]);
    expect(out).toHaveLength(1);
    expect(out[0].writtenAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("주어진 externalId는 보존한다", () => {
    const out = normalizeImportedReviews([{ externalId: "naver-r-123", rating: 5, content: "x", writtenAt: "2026-07-01" }]);
    expect(out[0].externalId).toBe("naver-r-123");
  });

  it("imageUrls는 문자열만 통과(포토리뷰 판정 근거)", () => {
    const out = normalizeImportedReviews([
      { rating: 5, content: "포토", writtenAt: "2026-07-01", imageUrls: ["u1", 123, null, "u2"] },
    ]);
    expect(out[0].imageUrls).toEqual(["u1", "u2"]);
  });

  it("배열이 아니면 빈 배열", () => {
    expect(normalizeImportedReviews(null)).toEqual([]);
    expect(normalizeImportedReviews({})).toEqual([]);
    expect(normalizeImportedReviews("x")).toEqual([]);
  });
});
