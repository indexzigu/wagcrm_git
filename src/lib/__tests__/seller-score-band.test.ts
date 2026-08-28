import { describe, it, expect } from "vitest";
import {
  resolveSellerScoreBand,
  SELLER_SCORE_BAND_TEXT,
  COMPOSITE_RECOMMEND_THRESHOLD,
  COMPOSITE_HOLD_THRESHOLD,
  type SellerScoreBand as SellerScoreBandKey,
} from "../seller-score-band";
import { buildFieldSuggestions, type ReviewCurrentFields } from "../seller-analysis/reviewMapping";
import { computeSubScores } from "../seller-analysis/scores";

describe("seller-score-band: 경계", () => {
  it("추천 경계는 '이상'이다 (65는 추천, 64는 보류)", () => {
    expect(resolveSellerScoreBand(COMPOSITE_RECOMMEND_THRESHOLD)).toBe("recommend");
    expect(resolveSellerScoreBand(COMPOSITE_RECOMMEND_THRESHOLD - 1)).toBe("hold");
  });

  it("보류 하한도 '이상'이다 (48은 보류, 47은 비추천)", () => {
    expect(resolveSellerScoreBand(COMPOSITE_HOLD_THRESHOLD)).toBe("hold");
    expect(resolveSellerScoreBand(COMPOSITE_HOLD_THRESHOLD - 1)).toBe("reject");
  });

  it("스케일 양끝", () => {
    expect(resolveSellerScoreBand(100)).toBe("recommend");
    expect(resolveSellerScoreBand(0)).toBe("reject");
  });
});

describe("seller-score-band: 미분석은 0점이 아니다", () => {
  // seller-fit.ts 가 고쳤던 결함과 같은 함정 — 미입력을 0으로 합산해 평가 안 한 셀러가 낙제했었다.
  it.each([null, undefined, NaN, Infinity])("판단 불가(%s)는 null 이지 reject 가 아니다", (v) => {
    expect(resolveSellerScoreBand(v as number | null | undefined)).toBeNull();
  });
});

describe("seller-score-band: 색 토큰", () => {
  it("양끝만 색이고 가운데는 무채색이다 (오너 확정 B안)", () => {
    // emerald-600(3.77) 같은 AA 미달 리터럴 재유입도 여기서 깨진다.
    expect(SELLER_SCORE_BAND_TEXT).toEqual({
      recommend: "text-status-success",
      hold: "text-slate-800",
      reject: "text-status-urgent-text",
    });
  });

  it("hold 의 무채색은 폴백이 아니라 등급이다 — 미분석(null)과 다른 값이어야 한다", () => {
    // 둘 다 무채색이지만 의미가 다르다: hold=판단해서 '볼 것 없음' / null=판단 불가.
    // 호출부가 hold 를 null 취급하면(또는 그 반대) 이 구분이 무너진다.
    expect(resolveSellerScoreBand(50)).toBe("hold");
    expect(resolveSellerScoreBand(null)).toBeNull();
  });

  it("세 밴드의 색이 서로 다르다 (밴드가 구분돼야 색이 정보를 나른다)", () => {
    const tones = Object.values(SELLER_SCORE_BAND_TEXT);
    expect(new Set(tones).size).toBe(tones.length);
  });

  it("자금 축(money-in-text)을 쓰지 않는다 — AI 점수는 돈이 아니라 품질 판정이다", () => {
    // #047857 로 값이 같아도 토큰이 갈린 이유(profit-tone.ts 참조). 축 오용 방지.
    for (const tone of Object.values(SELLER_SCORE_BAND_TEXT)) {
      expect(tone).not.toContain("money-in");
      expect(tone).not.toContain("money-out");
    }
  });
});

describe("seller-score-band: 화면 색과 저장되는 제안 등급이 갈리지 않는다", () => {
  // 컷 값(65/48) 자체는 reviewMapping.test.ts 가 고정한다 — 여기서 복제하지 않는다.
  // 이 describe 가 덮는 건 **새로 생긴 위험**뿐이다: 색과 제안 등급이 서로 어긋나는 것
  // ("추천"으로 저장되는데 화면엔 빨갛게 뜨는 사고). reviewMapping 이 이 leaf 의 상수를
  // import 하므로 지금은 구조적으로 갈릴 수 없지만, 상수를 도로 로컬 정의로 되돌리는
  // 회귀가 생기면 아래 단언이 잡는다.
  const EMPTY_CURRENT: ReviewCurrentFields = {
    activityFrequency: null,
    adResponseScore: null,
    commentResponseScore: null,
    collaborationScore: null,
    category: null,
    fitLevel: null,
  };

  const BAND_TO_FIT: Record<SellerScoreBandKey, string> = {
    recommend: "추천",
    hold: "보류",
    reject: "비추천",
  };

  function suggestedFitLevel(composite: number) {
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, {
      ...computeSubScores(undefined),
      composite,
    });
    return rows.find((r) => r.field === "fitLevel")?.suggested ?? null;
  }

  it.each([100, 65, 64, 48, 47, 0])("composite=%i 에서 밴드와 제안 등급이 일치한다", (score) => {
    const band = resolveSellerScoreBand(score);
    expect(band).not.toBeNull();
    expect(suggestedFitLevel(score)).toBe(BAND_TO_FIT[band as SellerScoreBandKey]);
  });

  it("미분석은 양쪽 다 '판단 불가'다 (한쪽만 낙제시키지 않는다)", () => {
    expect(resolveSellerScoreBand(null)).toBeNull();
    const rows = buildFieldSuggestions(EMPTY_CURRENT, undefined, {
      ...computeSubScores(undefined),
      composite: null,
    });
    expect(rows.find((r) => r.field === "fitLevel")?.suggested).toBeNull();
  });
});
