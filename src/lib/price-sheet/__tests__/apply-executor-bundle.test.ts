/**
 * 묶음 모드의 액션 변환 계약 — 설계 §3.
 * 실제 DB 쓰기(runApplyActions)는 apply-executor.transaction.test.ts 소관이다.
 */
import { describe, expect, it } from "vitest";
import { buildApplyActions } from "../apply-executor";
import type { ApplyRowInput, BundlePolicy } from "../grouping";

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

describe("buildApplyActions — 묶음 모드", () => {
  it("기존 딜 붙이기는 attachDealOptions 액션 1개로 변환된다", () => {
    const bundle: BundlePolicy = {
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
    const actions = buildApplyActions([row("r1", "제품A"), row("r2", "제품B")], null, undefined, bundle);
    expect(actions).toHaveLength(1);
    expect(actions[0].method).toBe("attachDealOptions");
    const [payload] = actions[0].args as [{ parentDealId: string; options: unknown[] }];
    expect(payload.parentDealId).toBe("parent-1");
    expect(payload.options).toHaveLength(2);
  });

  it("신규 상위딜 묶기는 기존 createDealGroup 경로를 그대로 쓴다", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: { kind: "NEW", parentDealName: "묶음딜" },
      excludedRowIds: [],
    };
    const actions = buildApplyActions([row("r1", "제품A"), row("r2", "제품B")], null, undefined, bundle);
    expect(actions).toHaveLength(1);
    expect(actions[0].method).toBe("createDealGroup");
  });

  it("제외된 행은 별도 createDeal 액션이 된다", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: { kind: "NEW", parentDealName: "묶음딜" },
      excludedRowIds: ["r3"],
    };
    const actions = buildApplyActions(
      [row("r1", "제품A"), row("r2", "제품B"), row("r3", "제외제품")],
      null,
      undefined,
      bundle
    );
    expect(actions.filter((a) => a.method === "createDealGroup")).toHaveLength(1);
    expect(actions.filter((a) => a.method === "createDeal")).toHaveLength(1);
  });

  it("MAPPED 행은 묶음 모드에서도 updateDeal로 남는다", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: { kind: "NEW", parentDealName: "묶음딜" },
      excludedRowIds: [],
    };
    const actions = buildApplyActions(
      [row("r1", "제품A"), row("r2", "제품B", { mappingStatus: "MAPPED", mappedDealId: "deal-9" })],
      null,
      undefined,
      bundle
    );
    expect(actions.filter((a) => a.method === "updateDeal")).toHaveLength(1);
  });

  it("bundle 미전달 시 기존 동작이 그대로다", () => {
    const actions = buildApplyActions(
      [row("r1", "제품A", { optionName: "2팩" }), row("r2", "제품A", { optionName: "6팩" })],
      null
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].method).toBe("createDealGroup");
  });
});
