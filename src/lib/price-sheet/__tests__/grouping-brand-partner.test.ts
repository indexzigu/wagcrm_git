import { describe, expect, it } from "vitest";
import {
  computeDealGroups,
  extractBrandName,
  matchPartnerByBrand,
  type ApplyRowInput,
} from "../grouping";

function newRow(overrides: Partial<ApplyRowInput> = {}): ApplyRowInput {
  return {
    id: "row",
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName: "비비랩 애사비 젤리",
    optionName: "애사비 젤리 2팩",
    sellingPrice: 18000,
    supplyPrice: 10800,
    listPrice: 30800,
    floorPrice: null,
    commissionRate: 0.4,
    discountRate: 0.42,
    ...overrides,
  };
}

describe("extractBrandName — 제품명 첫 토큰 브랜드 추출", () => {
  it("'비비랩 애사비 젤리' → '비비랩'", () => {
    expect(extractBrandName("비비랩 애사비 젤리")).toBe("비비랩");
  });
  it("괄호 장식은 벗긴다", () => {
    expect(extractBrandName("(비비랩) 프로바이오틱스")).toBe("비비랩");
  });
  it("1글자 토큰·빈 값은 브랜드로 보지 않는다", () => {
    expect(extractBrandName("A 제품")).toBeNull();
    expect(extractBrandName(null)).toBeNull();
    expect(extractBrandName("  ")).toBeNull();
  });
});

describe("matchPartnerByBrand — 브랜드명 거래처 자동 매칭", () => {
  const partners = [
    { id: "p1", name: "뉴트리원" },
    { id: "p2", name: "비비랩 코리아" },
  ];
  it("정확 일치 우선", () => {
    expect(matchPartnerByBrand([{ id: "px", name: "비비랩" }, ...partners], "비비랩")?.id).toBe(
      "px"
    );
  });
  it("포함 관계 매칭(거래처명 ⊇ 브랜드)", () => {
    expect(matchPartnerByBrand(partners, "비비랩")?.id).toBe("p2");
  });
  it("매칭 없으면 null", () => {
    expect(matchPartnerByBrand(partners, "센토메가")).toBeNull();
    expect(matchPartnerByBrand(partners, null)).toBeNull();
  });
});

describe("computeDealGroups — 브랜드·거래처 오버라이드", () => {
  it("오버라이드 없으면 브랜드=추출 제안값, 거래처=시트 거래처가 payload에 실린다", () => {
    const rows = [
      newRow({ id: "r1", optionName: "애사비 젤리 2팩" }),
      newRow({ id: "r2", optionName: "애사비 젤리 6팩" }),
    ];
    const { groups } = computeDealGroups(rows, "sheet-partner");
    expect(groups).toHaveLength(1);
    expect(groups[0].suggestedBrandName).toBe("비비랩");
    expect(groups[0].parent.brandName).toBe("비비랩");
    expect(groups[0].parent.partnerId).toBe("sheet-partner");
    expect(groups[0].options?.every((o) => o.brandName === "비비랩")).toBe(true);
  });

  it("오버라이드가 있으면 상위딜·하위딜 모두에 그 값이 실린다", () => {
    const rows = [
      newRow({ id: "r1", optionName: "애사비 젤리 2팩" }),
      newRow({ id: "r2", optionName: "애사비 젤리 6팩" }),
    ];
    const base = computeDealGroups(rows, null);
    const groupKey = base.groups[0].groupKey;
    const { groups } = computeDealGroups(rows, null, {
      [groupKey]: { brandName: "수정브랜드", partnerId: "partner-9" },
    });
    expect(groups[0].parent.brandName).toBe("수정브랜드");
    expect(groups[0].parent.partnerId).toBe("partner-9");
    expect(groups[0].options?.every((o) => o.brandName === "수정브랜드")).toBe(true);
    expect(groups[0].options?.every((o) => o.partnerId === "partner-9")).toBe(true);
  });

  it("명시적 null(연결 안 함)은 시트 거래처로 되살아나지 않는다", () => {
    const rows = [newRow({ id: "r1" })];
    const base = computeDealGroups(rows, "sheet-partner");
    const groupKey = base.groups[0].groupKey;
    const { groups } = computeDealGroups(rows, "sheet-partner", {
      [groupKey]: { brandName: null, partnerId: null },
    });
    expect(groups[0].parent.brandName).toBeNull();
    expect(groups[0].parent.partnerId).toBeNull();
  });

  it("groupKey는 오버라이드 유무와 무관하게 동일하다(클라 계산 키 = 서버 적용 키)", () => {
    const rows = [
      newRow({ id: "r1", optionName: "애사비 젤리 2팩" }),
      newRow({ id: "r2", optionName: "애사비 젤리 6팩" }),
    ];
    const withoutOverride = computeDealGroups(rows, null);
    const key = withoutOverride.groups[0].groupKey;
    const withOverride = computeDealGroups(rows, null, {
      [key]: { brandName: "x", partnerId: "y" },
    });
    expect(withOverride.groups[0].groupKey).toBe(key);
  });

  it("빈 컨테이너(단위 1 없음) 상위딜에도 브랜드·거래처가 실린다", () => {
    const rows = [
      newRow({ id: "r1", optionName: "애사비 젤리 2팩" }),
      newRow({ id: "r2", optionName: "애사비 젤리 6팩" }),
    ];
    const { groups } = computeDealGroups(rows, "sheet-partner");
    expect(groups[0].parentPriceSource).toBe("empty");
    expect(groups[0].parent.brandName).toBe("비비랩");
    expect(groups[0].parent.partnerId).toBe("sheet-partner");
  });
});
