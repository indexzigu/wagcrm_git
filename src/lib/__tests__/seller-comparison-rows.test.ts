import { describe, expect, it } from "vitest";
import {
  BEST_VALUE_MIN_CANDIDATES,
  HIGHER_IS_BETTER_ROW_KEYS,
  SELLER_COMPARE_MAX,
  applyCompareSelection,
  buildComparisonTable,
  normalizeComparisonIds,
  pickBestIndex,
  sellerCompareHref,
  type ComparisonTable,
  type SellerComparisonSource,
} from "../seller-comparison-rows";

// [셀러분석] 셀러 비교표 순수 모듈. 픽스처는 전부 가상 값이다(실명·운영 수치 없음).

const NOW = new Date("2026-06-15T00:00:00Z");

function source(overrides: Partial<SellerComparisonSource> & { id: string }): SellerComparisonSource {
  return {
    name: `가상 셀러 ${overrides.id}`,
    alias: null,
    currentFollowers: 10_000,
    fitLevel: null,
    analysis: null,
    campaigns: [],
    followerSnapshots: [],
    ...overrides,
  };
}

function analysis(er: number, confidence: string | null = "high") {
  return {
    analyzedAt: "2026-06-10T00:00:00Z",
    compositeScore: 70,
    confidence,
    category: "뷰티",
    metrics: { engagement: { er, commentToLikeRatio: er / 10 } },
    profileMeta: null,
    postsLite: [],
  };
}

function row(table: ComparisonTable, key: string) {
  const found = table.sections.flatMap((s) => s.rows).find((r) => r.key === key);
  if (!found) throw new Error(`row ${key} missing`);
  return found;
}

describe("normalizeComparisonIds", () => {
  it("쉼표 분리·공백 제거·중복 제거(순서 유지)", () => {
    expect(normalizeComparisonIds(" b, a ,b,,c ")).toEqual({ ids: ["b", "a", "c"], droppedCount: 0 });
  });

  it("9개 이상이면 앞 8개만 남기고 나머지를 뺀 수로 센다", () => {
    const raw = Array.from({ length: 9 }, (_, i) => `id${i}`).join(",");
    const result = normalizeComparisonIds(raw);
    expect(result.ids).toHaveLength(SELLER_COMPARE_MAX);
    expect(result.ids.at(-1)).toBe("id7");
    expect(result.droppedCount).toBe(1);
  });

  it("형식이 틀린 id 는 빼고 센다 · 반복 키(배열)도 받는다 · 비어 있으면 0명", () => {
    expect(normalizeComparisonIds(["a", "b;drop", "c"])).toEqual({ ids: ["a", "c"], droppedCount: 1 });
    expect(normalizeComparisonIds(undefined)).toEqual({ ids: [], droppedCount: 0 });
  });
});

describe("applyCompareSelection — 8명 상한", () => {
  const eight = Array.from({ length: 8 }, (_, i) => `s${i}`);

  it("9번째 담기는 막고 limitHit 을 켠다", () => {
    expect(applyCompareSelection(eight, [...eight, "s8"])).toEqual({ ids: eight, limitHit: true });
  });

  it("8명까지는 담기고, 빼기는 언제나 통과한다", () => {
    expect(applyCompareSelection(eight.slice(0, 7), eight)).toEqual({ ids: eight, limitHit: false });
    expect(applyCompareSelection(eight, eight.slice(1))).toEqual({ ids: eight.slice(1), limitHit: false });
  });

  it("비교 주소는 id 를 인코딩해 쉼표로 잇는다", () => {
    expect(sellerCompareHref(["a", "b"])).toBe("/sellers/compare?ids=a,b");
  });
});

describe("pickBestIndex", () => {
  const cell = (numeric: number | null, insufficient = false, text = String(numeric)) => ({
    numeric,
    insufficient,
    text,
  });

  it("유일한 최댓값의 위치를 고른다", () => {
    expect(pickBestIndex([cell(1), cell(3), cell(2)])).toBe(1);
  });

  it("최댓값 동률이면 강조하지 않는다", () => {
    expect(pickBestIndex([cell(3), cell(3), cell(2)])).toBeNull();
  });

  it("최댓값이 0 이하이면(모두 감소·모두 0) 강조하지 않는다", () => {
    expect(pickBestIndex([cell(-1), cell(-3), cell(-2)])).toBeNull();
    expect(pickBestIndex([cell(0), cell(-3), cell(-2)])).toBeNull();
  });

  it("원래 값은 달라도 화면 글자가 같으면 동률로 보고 강조하지 않는다", () => {
    expect(pickBestIndex([cell(4.44, false, "+4.4%"), cell(4.41, false, "+4.4%"), cell(4.38, false, "+4.4%")])).toBeNull();
    expect(pickBestIndex([cell(4.44, false, "+4.4%"), cell(4.41, false, "+4.4%"), cell(5.1, false, "+5.1%")])).toBe(2);
  });

  it(`비교 대상이 ${BEST_VALUE_MIN_CANDIDATES}개 미만이면(2열 이하) 강조하지 않는다`, () => {
    expect(pickBestIndex([cell(1), cell(5)])).toBeNull();
  });

  it("값 없음·표본 부족은 후보에서 빠지고, 그 결과 후보가 모자라면 강조하지 않는다", () => {
    expect(pickBestIndex([cell(null), cell(9, true), cell(1), cell(2)])).toBeNull();
    expect(pickBestIndex([cell(null), cell(9, true), cell(1), cell(2), cell(3)])).toBe(4);
  });
});

describe("buildComparisonTable", () => {
  it("행 순서: 우리와의 실적 → 규모·반응 → 상업성 → 상태 → 종합점수, 우리와의 실적만 내부 전용", () => {
    const table = buildComparisonTable([source({ id: "a" }), source({ id: "b" })], NOW);
    expect(table.sections.map((s) => s.key)).toEqual(["ours", "scale", "commerce", "status", "score"]);
    expect(table.sections.filter((s) => s.internal).map((s) => s.key)).toEqual(["ours"]);
    expect(row(table, "compositeScore").note).toBe("매출과의 상관이 확인되지 않은 참고 점수");
  });

  it("별칭이 있으면 별칭을 열 제목으로 쓴다", () => {
    const table = buildComparisonTable([source({ id: "a", alias: "가상 별칭" }), source({ id: "b" })], NOW);
    expect(table.columns.map((c) => c.displayName)).toEqual(["가상 별칭", "가상 셀러 b"]);
  });

  it("미분석 열은 분석 지표 행만 「미분석」이고 실적·팔로워 행은 그대로 보인다", () => {
    const table = buildComparisonTable(
      [source({ id: "a" }), source({ id: "b", analysis: analysis(0.03) })],
      NOW,
    );
    expect(row(table, "engagementRate").cells[0].text).toBe("미분석");
    expect(row(table, "followers").cells[0].text).toBe("10,000");
    expect(row(table, "effectiveCampaigns").cells[0].text).toBe("0회");
    expect(row(table, "engagementRate").cells[1].text).toBe("3.00%");
  });

  it("실적: 그룹은 1회로 접고, 평균 매출은 매출 확인 건수를 분모로 밝힌다", () => {
    const campaign = (groupId: string | null, actualSales: number | null) => ({
      actualSales,
      sellerFeeBasisOverride: null,
      sellerMarginRate: 0.1,
      campaignDeals: [],
      groupId,
      status: "CLOSED",
      startDate: "2026-06-05T00:00:00Z",
    });
    const table = buildComparisonTable(
      [
        source({ id: "a", campaigns: [campaign("g1", 1_000_000), campaign("g1", 1_000_000), campaign(null, null)] }),
        source({ id: "b" }),
      ],
      NOW,
    );
    expect(row(table, "effectiveCampaigns").cells[0].text).toBe("2회");
    const avg = row(table, "avgSales").cells[0];
    expect(avg.text).toBe("200만원");
    expect(avg.subText).toBe("매출 확인 1건 기준");
    expect(row(table, "lastRun").cells[0].text).toBe("10일 전");
  });

  it("최고값은 「높을수록 좋다」 행에만 붙는다 — 광고 비중·팔로워·종합점수는 제외", () => {
    expect(HIGHER_IS_BETTER_ROW_KEYS).not.toContain("adShare");
    expect(HIGHER_IS_BETTER_ROW_KEYS).not.toContain("gonguShare");
    expect(HIGHER_IS_BETTER_ROW_KEYS).not.toContain("followers");
    expect(HIGHER_IS_BETTER_ROW_KEYS).not.toContain("compositeScore");
    expect(HIGHER_IS_BETTER_ROW_KEYS).not.toContain("lastRun");

    const table = buildComparisonTable(
      [
        source({ id: "a", currentFollowers: 50_000, analysis: analysis(0.01) }),
        source({ id: "b", currentFollowers: 20_000, analysis: analysis(0.05) }),
        source({ id: "c", currentFollowers: 10_000, analysis: analysis(0.02) }),
      ],
      NOW,
    );
    expect(row(table, "engagementRate").cells.map((c) => c.isBest)).toEqual([false, true, false]);
    expect(row(table, "followers").cells.some((c) => c.isBest)).toBe(false);
    expect(row(table, "compositeScore").cells.some((c) => c.isBest)).toBe(false);
  });

  it("분석 신뢰도 낮음은 최고 후보에서 빠진다", () => {
    const table = buildComparisonTable(
      [
        source({ id: "a", analysis: analysis(0.09, "low") }),
        source({ id: "b", analysis: analysis(0.05) }),
        source({ id: "c", analysis: analysis(0.02) }),
        source({ id: "d", analysis: analysis(0.01) }),
      ],
      NOW,
    );
    expect(row(table, "engagementRate").cells.map((c) => c.isBest)).toEqual([false, true, false, false]);
  });

  it("2열이면 어떤 행도 강조하지 않는다", () => {
    const table = buildComparisonTable(
      [source({ id: "a", analysis: analysis(0.01) }), source({ id: "b", analysis: analysis(0.05) })],
      NOW,
    );
    const anyBest = table.sections.flatMap((s) => s.rows).some((r) => r.cells.some((c) => c.isBest));
    expect(anyBest).toBe(false);
  });
});

describe("릴스 조회 배수 행 (PR-2)", () => {
  function reachAnalysis(multiple: number | null, viewSource: "views" | "plays" | "mixed" | null, reason: string | null = null) {
    return {
      ...analysis(0.02),
      metrics: {
        engagement: { er: 0.02, commentToLikeRatio: 0.002 },
        reach: {
          reelViewMultiple: multiple,
          medianReelViews: multiple === null ? null : multiple * 1000,
          reelViewSample: multiple === null ? 0 : 5,
          reelsWithoutViews: 0,
          reelCount: 5,
          viewSource,
          unavailableReason: reason,
        },
      },
    };
  }

  it("규모·반응에서 참여율과 댓글 반응률 사이 · 높을수록 좋은 행", () => {
    const table = buildComparisonTable([source({ id: "a" }), source({ id: "b" })], NOW);
    const scale = table.sections.find((s) => s.key === "scale")!;
    const keys = scale.rows.map((r) => r.key);
    expect(keys.indexOf("reelViewMultiple")).toBe(keys.indexOf("engagementRate") + 1);
    expect(keys.indexOf("commentToLike")).toBe(keys.indexOf("reelViewMultiple") + 1);
    expect(row(table, "reelViewMultiple").label).toBe("릴스 조회 배수");
    expect(HIGHER_IS_BETTER_ROW_KEYS).toContain("reelViewMultiple");
  });

  it("같은 원천이면 값·최고값 강조 · 값 없음은 사유 낱말(과거 분석본 = 미수집, 미분석)", () => {
    const table = buildComparisonTable(
      [
        source({ id: "a", analysis: reachAnalysis(1.2, "views") }),
        source({ id: "b", analysis: reachAnalysis(2.5, "views") }),
        source({ id: "c", analysis: reachAnalysis(0.8, "views") }),
        source({ id: "d", analysis: analysis(0.02) }),
        source({ id: "e" }),
      ],
      NOW,
    );
    const cells = row(table, "reelViewMultiple").cells;
    expect(cells.map((c) => c.text)).toEqual(["1.2배", "2.5배", "0.8배", "미수집", "미분석"]);
    expect(cells.map((c) => c.isBest)).toEqual([false, true, false, false, false]);
    expect(cells.some((c) => c.subText === "기준 다름")).toBe(false);
  });

  it("조회수 원천이 열마다 다르면 값 칸에 「기준 다름」 · 최고값 강조 없음", () => {
    const table = buildComparisonTable(
      [
        source({ id: "a", analysis: reachAnalysis(1.2, "views") }),
        source({ id: "b", analysis: reachAnalysis(2.5, "plays") }),
        source({ id: "c", analysis: reachAnalysis(0.8, "views") }),
        source({ id: "d", analysis: reachAnalysis(null, null, "NO_REELS") }),
      ],
      NOW,
    );
    const cells = row(table, "reelViewMultiple").cells;
    expect(cells.map((c) => c.subText ?? null)).toEqual(["기준 다름", "기준 다름", "기준 다름", null]);
    expect(cells[3].text).toBe("릴스 없음");
    expect(cells.every((c) => !c.isBest)).toBe(true);
  });
});
