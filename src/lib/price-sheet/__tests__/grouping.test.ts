/**
 * computeDealGroups 직접 테스트 — 프리뷰 전용 필드(parentPriceSource·rowIds·skippedRowIds).
 * 액션 변환을 경유한 그룹핑 규칙 자체는 apply-executor-grouping.test.ts가 커버한다.
 */
import { describe, expect, it } from "vitest";
import { computeDealGroups, type ApplyRowInput } from "../grouping";

function newRow(overrides: Partial<ApplyRowInput> = {}): ApplyRowInput {
  return {
    id: "row",
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName: "제품A",
    optionName: "2팩",
    sellingPrice: 18000,
    supplyPrice: 10800,
    listPrice: null,
    floorPrice: null,
    commissionRate: 0.4,
    discountRate: null,
    ...overrides,
  };
}

describe("computeDealGroups — 프리뷰 계약", () => {
  it("단위 1 옵션이 없으면 parentPriceSource='empty'(빈 컨테이너 0원)", () => {
    const { groups } = computeDealGroups(
      [newRow({ id: "r1", optionName: "2팩" }), newRow({ id: "r2", optionName: "6팩" })],
      null
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].parentPriceSource).toBe("empty");
    expect(groups[0].parent.sellingPrice).toBe(0);
    expect(groups[0].rowIds).toEqual(["r1", "r2"]);
  });

  it("단위 1 옵션이 있으면 parentPriceSource='base-option'이고 그 값을 상속", () => {
    const { groups } = computeDealGroups(
      [
        newRow({ id: "r0", optionName: "1팩", sellingPrice: 9900 }),
        newRow({ id: "r1", optionName: "2팩" }),
      ],
      null
    );
    expect(groups[0].parentPriceSource).toBe("base-option");
    expect(groups[0].parent.sellingPrice).toBe(9900);
  });

  it("그룹 크기 1이면 options=null, parentPriceSource='single'", () => {
    const { groups } = computeDealGroups([newRow({ id: "solo" })], null);
    expect(groups[0].options).toBeNull();
    expect(groups[0].parentPriceSource).toBe("single");
  });

  it("필수값(판매가) 누락 NEW_DEAL 행은 skippedRowIds로 보고된다", () => {
    const { groups, skippedRowIds } = computeDealGroups(
      [
        newRow({ id: "ok1", optionName: "2팩" }),
        newRow({ id: "ok2", optionName: "6팩" }),
        newRow({ id: "bad", optionName: "12팩", sellingPrice: null }),
      ],
      null
    );
    expect(skippedRowIds).toEqual(["bad"]);
    expect(groups[0].rowIds).toEqual(["ok1", "ok2"]);
  });

  it("MAPPED/SUGGESTED/UNMAPPED 행은 그룹핑 대상이 아니다", () => {
    const { groups, skippedRowIds } = computeDealGroups(
      [
        newRow({ id: "m", mappingStatus: "MAPPED", mappedDealId: "deal-1" }),
        newRow({ id: "s", mappingStatus: "SUGGESTED" }),
        newRow({ id: "u", mappingStatus: "UNMAPPED" }),
      ],
      null
    );
    expect(groups).toHaveLength(0);
    expect(skippedRowIds).toHaveLength(0);
  });
});
