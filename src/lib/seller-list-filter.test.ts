import { describe, expect, it } from "vitest";
import type { SellerSummary } from "@/lib/crm-types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSellerListQuery,
  describeSellerListFilter,
  matchesSellerListFilter,
  parseSellerListFilter,
  SELLER_LIST_FILTER_PARAM_KEYS,
  SELLER_SEGMENT_LABELS,
} from "./seller-list-filter";

function seller(over: Partial<SellerSummary> = {}): SellerSummary {
  return {
    id: "s1",
    name: "샘플",
    snsType: "INSTAGRAM",
    snsHandle: "sample.demo",
    currentFollowers: 30000,
    category: "육아",
    aiComposite: 70,
    campaignCount: 0,
    ...over,
  };
}

const parse = (query: string) => parseSellerListFilter(new URLSearchParams(query));

describe("parseSellerListFilter", () => {
  it("빈 주소는 조건 없음", () => {
    const { filter, unreadable } = parse("");
    expect(filter).toEqual({});
    expect(unreadable).toEqual([]);
  });

  it("지원 파라미터를 모두 읽는다", () => {
    const { filter, unreadable } = parse(
      "segment=prospect&snsType=YOUTUBE&category=%EC%9C%A1%EC%95%84&minFollowers=10000&maxFollowers=50000&minEr=2.5",
    );
    expect(unreadable).toEqual([]);
    expect(filter).toEqual({
      segment: "prospect",
      snsType: "YOUTUBE",
      category: "육아",
      minFollowers: 10000,
      maxFollowers: 50000,
      minEngagementPct: 2.5,
    });
  });

  it("잘못된 값은 버리되 읽지 못한 조건으로 돌려준다(조용히 버리지 않음)", () => {
    const { filter, unreadable } = parse(
      "minFollowers=-5&maxFollowers=abc&minEr=0&segment=vip&snsType=TIKTOK&category=",
    );
    expect(filter).toEqual({});
    expect(unreadable.map((u) => u.param).sort()).toEqual(
      ["category", "maxFollowers", "minEr", "minFollowers", "segment", "snsType"].sort(),
    );
  });

  it("반영 못한 조건은 한글 이름과 값으로 표시(20자 자름)", () => {
    expect(parse("minEr=abc").unreadable[0]?.label).toBe("참여율 「abc」");
    expect(parse("minFollowers=50000&maxFollowers=10000").unreadable[0]?.label).toBe(
      "팔로워 범위 「50000~10000」",
    );
    expect(parse(`snsType=${"A".repeat(25)}`).unreadable[0]?.label).toBe(`채널 「${"A".repeat(20)}…」`);
  });

  it("minEr 상한 100, 소수점 둘째 자리까지", () => {
    expect(parse("minEr=100").filter.minEngagementPct).toBe(100);
    expect(parse("minEr=100.5").unreadable).toHaveLength(1);
    expect(parse("minEr=2.555").unreadable).toHaveLength(1);
  });

  it("팔로워 하한이 상한보다 크면 둘 다 읽지 못한 조건", () => {
    const { filter, unreadable } = parse("minFollowers=50000&maxFollowers=10000");
    expect(filter.minFollowers).toBeUndefined();
    expect(filter.maxFollowers).toBeUndefined();
    expect(unreadable).toHaveLength(1);
  });

  it("카테고리 30자 초과는 읽지 못한 조건, 앞뒤 공백은 정리", () => {
    expect(parse(`category=${"가".repeat(31)}`).unreadable).toHaveLength(1);
    expect(parse("category=%20%EC%9C%A1%EC%95%84%20").filter.category).toBe("육아");
  });

  it("segment=all 은 조건이 아니다(무시, 경고 아님)", () => {
    const { filter, unreadable } = parse("segment=all");
    expect(filter).toEqual({});
    expect(unreadable).toEqual([]);
  });

  it("q 는 기존 검색이 소유하므로 이 모듈은 읽지 않는다", () => {
    expect(parse("q=abc").filter).toEqual({});
    expect(SELLER_LIST_FILTER_PARAM_KEYS).not.toContain("q");
  });
});

describe("matchesSellerListFilter", () => {
  it("팔로워 범위는 양끝 포함", () => {
    const f = { minFollowers: 10000, maxFollowers: 50000 };
    expect(matchesSellerListFilter(seller({ currentFollowers: 10000 }), f)).toBe(true);
    expect(matchesSellerListFilter(seller({ currentFollowers: 50000 }), f)).toBe(true);
    expect(matchesSellerListFilter(seller({ currentFollowers: 9999 }), f)).toBe(false);
    expect(matchesSellerListFilter(seller({ currentFollowers: 50001 }), f)).toBe(false);
  });

  it("참여율은 비율×100 과 비교하고 미분석(null/undefined)은 제외", () => {
    const f = { minEngagementPct: 3 };
    expect(matchesSellerListFilter(seller(), f, { engagementRate: 0.03 })).toBe(true);
    expect(matchesSellerListFilter(seller(), f, { engagementRate: 0.0299 })).toBe(false);
    expect(matchesSellerListFilter(seller(), f, { engagementRate: null })).toBe(false);
    expect(matchesSellerListFilter(seller(), f)).toBe(false);
  });

  it("부동소수 경계: 0.07 비율은 7% 이상에 걸린다", () => {
    expect(matchesSellerListFilter(seller(), { minEngagementPct: 7 }, { engagementRate: 0.07 })).toBe(true);
  });

  it("참여율 조건이 없으면 참여율 값과 무관", () => {
    expect(matchesSellerListFilter(seller(), { category: "육아" })).toBe(true);
  });

  it("카테고리는 부분 일치·대소문자 무시, 카테고리 없으면 제외", () => {
    expect(matchesSellerListFilter(seller({ category: "육아용품" }), { category: "육아" })).toBe(true);
    expect(matchesSellerListFilter(seller({ category: "Beauty" }), { category: "beauty" })).toBe(true);
    expect(matchesSellerListFilter(seller({ category: "뷰티" }), { category: "육아" })).toBe(false);
    expect(matchesSellerListFilter(seller({ category: null }), { category: "육아" })).toBe(false);
  });

  it("채널·세그먼트", () => {
    expect(matchesSellerListFilter(seller(), { snsType: "YOUTUBE" })).toBe(false);
    expect(matchesSellerListFilter(seller(), { snsType: "INSTAGRAM" })).toBe(true);
    expect(matchesSellerListFilter(seller({ campaignCount: 2 }), { segment: "prospect" })).toBe(false);
    expect(matchesSellerListFilter(seller({ campaignCount: 0 }), { segment: "prospect" })).toBe(true);
  });

  it("조건 없음은 전부 통과", () => {
    expect(matchesSellerListFilter(seller(), {})).toBe(true);
  });
});

describe("buildSellerListQuery — 봇과 공유하는 예시표(설계 §6)", () => {
  it.each([
    [
      { minFollowers: 10000, maxFollowers: 50000, category: "육아", minEngagementPct: 3 },
      "category=%EC%9C%A1%EC%95%84&minFollowers=10000&maxFollowers=50000&minEr=3",
    ],
    [{ minFollowers: 100000 }, "minFollowers=100000"],
    [{ minEngagementPct: 2.5, snsType: "YOUTUBE" as const }, "snsType=YOUTUBE&minEr=2.5"],
    [{ segment: "prospect" as const }, "segment=prospect"],
    [{}, ""],
  ])("%j → %s", (filter, expected) => {
    expect(buildSellerListQuery(filter)).toBe(expected);
  });

  it("왕복: build → parse 가 같은 조건", () => {
    const filter = {
      segment: "dormant" as const,
      snsType: "X" as const,
      category: "푸드",
      minFollowers: 1,
      maxFollowers: 2,
      minEngagementPct: 0.01,
    };
    const back = parse(buildSellerListQuery(filter));
    expect(back.unreadable).toEqual([]);
    expect(back.filter).toEqual(filter);
  });
});

describe("describeSellerListFilter", () => {
  it("칩 문구 — 팔로워는 목록 열과 같은 표기", () => {
    expect(
      describeSellerListFilter({
        minFollowers: 10000,
        maxFollowers: 50000,
        category: "육아",
        minEngagementPct: 3,
        snsType: "INSTAGRAM",
      }),
    ).toEqual([
      "채널 Instagram",
      "카테고리 「육아」 포함",
      "팔로워 1.0만~5.0만",
      "참여율 3% 이상 (분석된 셀러만)",
    ]);
  });

  it("팔로워 한쪽만", () => {
    expect(describeSellerListFilter({ minFollowers: 100000 })).toEqual(["팔로워 10.0만 이상"]);
    expect(describeSellerListFilter({ maxFollowers: 8000 })).toEqual(["팔로워 8,000 이하"]);
  });

  it("세그먼트는 탭이 보여 주므로 칩에 넣지 않는다", () => {
    expect(describeSellerListFilter({ segment: "prospect" })).toEqual([]);
  });

  it("탭이 없는 모바일은 세그먼트도 칩으로 적는다 — 조건이 걸렸는데 안 보이는 일이 없게", () => {
    expect(describeSellerListFilter({ segment: "prospect" }, { includeSegment: true })).toEqual(["보기 「발굴 후보」"]);
    expect(
      describeSellerListFilter({ segment: "dormant", category: "육아" }, { includeSegment: true })[0],
    ).toBe("보기 「휴면」");
  });
});

describe("모바일 칩의 보기 이름 = 데스크톱 탭 이름", () => {
  it("SELLER_SEGMENT_LABELS 의 모든 라벨이 셀러 목록 탭 선택지에 그대로 있다", () => {
    const src = readFileSync(join(__dirname, "..", "components", "crm", "sellers-management.tsx"), "utf8");
    for (const [value, label] of Object.entries(SELLER_SEGMENT_LABELS)) {
      expect(src).toContain(`{ value: "${value}", label: "${label}" }`);
    }
  });
});
