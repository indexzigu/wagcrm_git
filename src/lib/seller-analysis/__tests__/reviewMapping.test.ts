// reviewMapping.ts — 검토후반영 카테고리 제안 행(병합 의미론·autoCheck 정책)과
// composite 컷 보정(>=65 추천 / >=48 보류)을 고정한다.
import { describe, it, expect } from "vitest";
import { buildFieldSuggestions, type ReviewCurrentFields } from "../reviewMapping";
import { computeSubScores } from "../scores";

const EMPTY_CURRENT: ReviewCurrentFields = {
  activityFrequency: null,
  adResponseScore: null,
  commentResponseScore: null,
  collaborationScore: null,
  category: null,
  fitLevel: null,
};

/** metrics 없음(방어 정규화) + composite만 주입한 SellerScores */
function scoresWithComposite(composite: number | null) {
  return { ...computeSubScores(undefined), composite };
}

function categoryRow(current: ReviewCurrentFields, aiCategory: string | null) {
  const rows = buildFieldSuggestions(current, undefined, scoresWithComposite(null), {
    category: aiCategory,
  });
  const row = rows.find((r) => r.field === "category");
  expect(row).toBeDefined();
  return row!;
}

describe("buildFieldSuggestions — 행 구성", () => {
  it("category 행이 추가돼 6행이며 라벨은 '카테고리'", () => {
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, scoresWithComposite(null), {
      category: "건강",
    });
    expect(rows.map((r) => r.field)).toEqual([
      "activityFrequency",
      "adResponseScore",
      "commentResponseScore",
      "collaborationScore",
      "category",
      "fitLevel",
    ]);
    expect(rows.find((r) => r.field === "category")!.label).toBe("카테고리");
  });

  it("aiCategory 인자 없이 호출(기존 콜사이트 호환)해도 category 행은 '판단 불가'로 안전", () => {
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, scoresWithComposite(null));
    const row = rows.find((r) => r.field === "category")!;
    expect(row.suggested).toBeNull();
    expect(row.autoCheck).toBe(false);
    expect(row.reason).toContain("AI 카테고리 판정 없음");
  });
});

describe("category 제안 — 병합 의미론과 autoCheck 정책", () => {
  it("완전 미입력 → LLM 카테고리 그대로 제안 + autoCheck true", () => {
    const row = categoryRow(EMPTY_CURRENT, "건강");
    expect(row.current).toBeNull();
    expect(row.suggested).toBe("건강");
    expect(row.match).toBe(false);
    expect(row.autoCheck).toBe(true);
    expect(row.reason).toContain("AI 주 카테고리 판정");
  });

  it("기존 태그 존재 + 미포함 → 전체 병합 문자열 제안, 기존 태그 보존, autoCheck false", () => {
    const row = categoryRow({ ...EMPTY_CURRENT, category: "공구, 리빙" }, "건강");
    expect(row.suggested).toBe("공구, 리빙, 건강");
    expect(row.match).toBe(false);
    expect(row.autoCheck).toBe(false); // 운영자 큐레이션 보호 — 병합도 사람 확인
  });

  it("구분자 공백 없는 기존 값도 태그를 잃지 않는다", () => {
    const row = categoryRow({ ...EMPTY_CURRENT, category: "공구,리빙" }, "건강");
    expect(row.suggested).toBe("공구, 리빙, 건강");
  });

  it("이미 포함 → match true(변경 없음), autoCheck false", () => {
    const row = categoryRow({ ...EMPTY_CURRENT, category: "공구, 건강" }, "건강");
    expect(row.suggested).toBe("공구, 건강"); // 현재값 그대로 → match 수렴
    expect(row.match).toBe(true);
    expect(row.autoCheck).toBe(false);
  });

  it("topAffinities가 있으면 근거에 성향 정보를 포함한다", () => {
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, scoresWithComposite(null), {
      category: "건강",
      topAffinities: [
        { category: "건강", score: 100 },
        { category: "식품", score: 65 },
      ],
    });
    const row = rows.find((r) => r.field === "category")!;
    expect(row.reason).toContain("건강 100");
    expect(row.reason).toContain("식품 65");
  });
});

describe("fitLevel 제안 — composite 컷 65/48 (Part B 보정)", () => {
  function fitRow(composite: number | null) {
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, scoresWithComposite(composite));
    return rows.find((r) => r.field === "fitLevel")!;
  }

  it("composite 65 → 추천 (구 컷 70이면 보류였을 값)", () => {
    expect(fitRow(65).suggested).toBe("추천");
  });

  it("composite 64 → 보류", () => {
    expect(fitRow(64).suggested).toBe("보류");
  });

  it("composite 48 → 보류 (구 컷 45 → 48 상향)", () => {
    expect(fitRow(48).suggested).toBe("보류");
  });

  it("composite 47 → 비추천", () => {
    expect(fitRow(47).suggested).toBe("비추천");
  });

  it("fitLevel은 제안이 있어도 autoCheck 항상 false (판단 필드)", () => {
    expect(fitRow(90).autoCheck).toBe(false);
  });

  it("composite null → 판단 불가", () => {
    expect(fitRow(null).suggested).toBeNull();
  });
});
