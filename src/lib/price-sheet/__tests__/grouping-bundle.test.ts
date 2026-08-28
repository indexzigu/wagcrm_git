/**
 * BUNDLE 모드 그룹핑 계약 — 설계 §2.
 * 서로 다른 제품을 한 상위딜 아래로 묶는 경로. AUTO(제품명+구성베이스) 규칙과 독립이다.
 */
import { describe, expect, it } from "vitest";
import {
  computeDealGroups,
  BUNDLE_GROUP_KEY,
  type ApplyRowInput,
  type BundlePolicy,
} from "../grouping";

function row(id: string, productName: string, overrides: Partial<ApplyRowInput> = {}): ApplyRowInput {
  return {
    id,
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName,
    optionName: null,
    sellingPrice: 10000,
    supplyPrice: 6000,
    listPrice: null,
    floorPrice: null,
    commissionRate: 0.4,
    discountRate: null,
    ...overrides,
  };
}

const NEW_BUNDLE: BundlePolicy = {
  mode: "BUNDLE",
  target: { kind: "NEW", parentDealName: "묶음딜" },
  excludedRowIds: [],
};

describe("computeDealGroups — BUNDLE(신규 상위딜)", () => {
  it("제품명이 전부 달라도 한 그룹으로 묶고 옵션명은 '상위딜명 - 제품명'", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B"), row("r3", "제품C")],
      null,
      undefined,
      NEW_BUNDLE
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe(BUNDLE_GROUP_KEY);
    expect(groups[0].parentDealName).toBe("묶음딜");
    expect(groups[0].options?.map((o) => o.dealName)).toEqual([
      "묶음딜 - 제품A",
      "묶음딜 - 제품B",
      "묶음딜 - 제품C",
    ]);
    expect(groups[0].attachToDealId).toBeNull();
  });

  it("상위딜은 0원 빈 컨테이너다(단위 1 상속 규칙은 적용되지 않는다)", () => {
    const { groups } = computeDealGroups([row("r1", "제품A"), row("r2", "제품B")], null, undefined, NEW_BUNDLE);
    expect(groups[0].parentPriceSource).toBe("empty");
    expect(groups[0].parent.sellingPrice).toBe(0);
    expect(groups[0].parent.dealType).toBe("MAIN");
  });

  it("제품명 스펙 문자열에서 수량·단위를 파싱하지 않는다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "네크리스 2mm 체인 40cm"), row("r2", "팔찌 16cm, 17cm")],
      null,
      undefined,
      NEW_BUNDLE
    );
    for (const option of groups[0].options ?? []) {
      expect(option.unitQuantity).toBeNull();
      expect(option.unit).toBeNull();
      expect(option.supplementaryInfo).toBeNull();
    }
  });

  it("행이 1건이어도 상위딜 + 하위 1개로 만든다(명시적 의도가 크기 휴리스틱을 이긴다)", () => {
    const { groups } = computeDealGroups([row("solo", "제품A")], null, undefined, NEW_BUNDLE);
    expect(groups[0].options).toHaveLength(1);
    expect(groups[0].parentDealName).toBe("묶음딜");
  });

  it("optionSortOrder는 0부터 순서대로 매겨진다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B"), row("r3", "제품C")],
      null,
      undefined,
      NEW_BUNDLE
    );
    expect(groups[0].options?.map((o) => o.optionSortOrder)).toEqual([0, 1, 2]);
    expect(groups[0].options?.every((o) => o.dealType === "OPTION")).toBe(true);
  });

  it("제외된 행은 묶음에서 빠지고 AUTO 규칙으로 별도 처리된다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B"), row("r3", "제외제품")],
      null,
      undefined,
      { ...NEW_BUNDLE, excludedRowIds: ["r3"] }
    );
    const bundle = groups.find((g) => g.groupKey === BUNDLE_GROUP_KEY);
    const auto = groups.filter((g) => g.groupKey !== BUNDLE_GROUP_KEY);
    expect(bundle?.options).toHaveLength(2);
    expect(auto).toHaveLength(1);
    expect(auto[0].parentDealName).toBe("제외제품");
    expect(auto[0].options).toBeNull();
  });

  it("NEW_DEAL이 아닌 행은 묶음 대상이 아니다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B", { mappingStatus: "MAPPED", mappedDealId: "deal-1" })],
      null,
      undefined,
      NEW_BUNDLE
    );
    expect(groups.find((g) => g.groupKey === BUNDLE_GROUP_KEY)?.options).toHaveLength(1);
  });

  it("필수값 누락 행은 skippedRowIds로 보고되고 묶음에 들어가지 않는다", () => {
    const { groups, skippedRowIds } = computeDealGroups(
      [row("ok", "제품A"), row("bad", "제품B", { sellingPrice: null })],
      null,
      undefined,
      NEW_BUNDLE
    );
    expect(skippedRowIds).toContain("bad");
    expect(groups.find((g) => g.groupKey === BUNDLE_GROUP_KEY)?.options).toHaveLength(1);
  });

  it("묶을 행이 하나도 없으면 묶음 그룹을 만들지 않는다", () => {
    const { groups } = computeDealGroups([], null, undefined, NEW_BUNDLE);
    expect(groups.find((g) => g.groupKey === BUNDLE_GROUP_KEY)).toBeUndefined();
  });

  it("브랜드·거래처 오버라이드가 묶음 키로 적용된다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B")],
      null,
      { [BUNDLE_GROUP_KEY]: { brandName: "브랜드B", partnerId: "partner-1" } },
      NEW_BUNDLE
    );
    const bundle = groups.find((g) => g.groupKey === BUNDLE_GROUP_KEY)!;
    expect(bundle.parent.brandName).toBe("브랜드B");
    expect(bundle.parent.partnerId).toBe("partner-1");
    expect(bundle.options?.every((o) => o.brandName === "브랜드B")).toBe(true);
    expect(bundle.options?.every((o) => o.partnerId === "partner-1")).toBe(true);
  });
});

describe("computeDealGroups — BUNDLE(기존 딜에 붙이기)", () => {
  const EXISTING_BUNDLE: BundlePolicy = {
    mode: "BUNDLE",
    target: {
      kind: "EXISTING",
      dealId: "parent-1",
      parentDealName: "기존상위딜",
      parentBrandName: "브랜드B",
      parentPartnerId: "partner-1",
    },
    excludedRowIds: [],
  };

  it("attachToDealId가 설정되고 parentPriceSource='existing'", () => {
    const { groups } = computeDealGroups([row("r1", "제품A")], null, undefined, EXISTING_BUNDLE);
    expect(groups[0].attachToDealId).toBe("parent-1");
    expect(groups[0].parentPriceSource).toBe("existing");
    expect(groups[0].parentDealName).toBe("기존상위딜");
  });

  it("하위딜의 브랜드·거래처는 부모 값을 따르며 오버라이드가 무시된다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A")],
      null,
      { [BUNDLE_GROUP_KEY]: { brandName: "무시될브랜드", partnerId: "무시될거래처" } },
      EXISTING_BUNDLE
    );
    expect(groups[0].options?.[0].brandName).toBe("브랜드B");
    expect(groups[0].options?.[0].partnerId).toBe("partner-1");
  });

  it("옵션 딜명은 기존 상위딜명을 접두로 쓴다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B")],
      null,
      undefined,
      EXISTING_BUNDLE
    );
    expect(groups[0].options?.map((o) => o.dealName)).toEqual([
      "기존상위딜 - 제품A",
      "기존상위딜 - 제품B",
    ]);
  });

  it("행 제품명이 기존 상위딜명과 같아도 접두를 중복 표기하지 않는다(formatOptionDealName 위임)", () => {
    // "협의 단계에 딜 기본정보만 먼저 등록" 워크플로우 — 상위딜이 제품 자신의 이름으로
    // 이미 등록돼 있을 때, 인라인 접두 조합이면 "제품A - 제품A"가 나온다.
    const SELF_NAMED_BUNDLE: BundlePolicy = {
      mode: "BUNDLE",
      target: {
        kind: "EXISTING",
        dealId: "parent-1",
        parentDealName: "제품A",
        parentBrandName: "브랜드B",
        parentPartnerId: "partner-1",
      },
      excludedRowIds: [],
    };
    const { groups } = computeDealGroups(
      [row("r1", "제품A"), row("r2", "제품B")],
      null,
      undefined,
      SELF_NAMED_BUNDLE
    );
    expect(groups[0].options?.map((o) => o.dealName)).toEqual([
      "제품A",
      "제품A - 제품B",
    ]);
  });
});

describe("computeDealGroups — AUTO 무손상", () => {
  it("bundle 인자를 안 주면 기존 동작 그대로다", () => {
    const { groups } = computeDealGroups(
      [
        row("r1", "제품A", { optionName: "1팩", sellingPrice: 9900 }),
        row("r2", "제품A", { optionName: "2팩" }),
      ],
      null
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].parentPriceSource).toBe("base-option");
    expect(groups[0].attachToDealId).toBeNull();
  });

  it("mode:'AUTO'를 명시해도 기존 동작 그대로다", () => {
    const { groups } = computeDealGroups(
      [row("r1", "제품A", { optionName: "2팩" }), row("r2", "제품A", { optionName: "6팩" })],
      null,
      undefined,
      { mode: "AUTO" }
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].options).toHaveLength(2);
  });
});
