/**
 * 비율 단위 경계 계약 — 가격표(0~1 소수) → 딜(퍼센트 수치).
 *
 * 두 저장소의 관례가 다르다:
 * · `PriceSheetRow.commissionRate` — `parseRateCell` 이 /100 하므로 50% 는 `0.5`.
 * · `Deal.totalCommissionRate` — `computeSupplyPrice` 가 /100 하므로 50% 는 `50`.
 *
 * 반영 실행기가 변환 없이 그대로 쓰면 50% 가 딜에서 **0.5%** 가 되고, 그 딜의 판매가를
 * 수정하는 순간 공급가가 `판매가 × (1 - 0.5/100)` = **판매가의 99.5%** 로 재계산된다.
 * 표시 오류가 아니라 발주까지 흘러갈 수 있는 금전 사고라 계약 테스트로 고정한다.
 *
 * 실사고: 프로덕션 딜 161건 중 19건이 이 상태로 저장돼 있었다(2026-08-01 실측).
 */
import { describe, expect, it } from "vitest";
import { buildApplyActionForRow, buildApplyActions } from "../apply-executor";
import {
  rateToDealPercent,
  type ApplyRowInput,
  type BundlePolicy,
  type DealCreatePayload,
} from "../grouping";

function row(overrides: Partial<ApplyRowInput> = {}): ApplyRowInput {
  return {
    id: "r1",
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName: "제품A",
    optionName: null,
    sellingPrice: 100000,
    supplyPrice: 50000,
    listPrice: null,
    floorPrice: null,
    commissionRate: 0.5,
    discountRate: 0.25,
    ...overrides,
  };
}

describe("rateToDealPercent — 단위 변환", () => {
  it("0~1 소수를 퍼센트 수치로 바꾼다", () => {
    expect(rateToDealPercent(0.5)).toBe(50);
    expect(rateToDealPercent(0.4)).toBe(40);
    expect(rateToDealPercent(0.25)).toBe(25);
  });

  it("나누어떨어지지 않는 비율은 소수점 둘째 자리까지 유지한다", () => {
    // 0.3333 * 100 = 33.33 — 부동소수 오차(33.329999…)가 그대로 저장되지 않아야 한다.
    expect(rateToDealPercent(0.3333)).toBe(33.33);
    expect(rateToDealPercent(0.3673)).toBe(36.73);
  });

  it("null·undefined 는 그대로 통과시킨다(값을 지어내지 않는다)", () => {
    expect(rateToDealPercent(null)).toBeNull();
    expect(rateToDealPercent(undefined)).toBeNull();
  });

  it("0 은 0 이다(0%는 유효한 값이라 null 로 접지 않는다)", () => {
    expect(rateToDealPercent(0)).toBe(0);
  });
});

describe("신규 딜 생성 — 비율이 퍼센트 수치로 저장된다", () => {
  it("단일 신규 딜: 0.5 → 50", () => {
    const actions = buildApplyActions([row()], null);
    const payload = actions[0].args[0] as DealCreatePayload;
    expect(payload.totalCommissionRate).toBe(50);
    expect(payload.discountRate).toBe(25);
  });

  it("묶음(신규 상위딜)의 하위품목도 퍼센트 수치로 저장된다", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: { kind: "NEW", parentDealName: "묶음딜" },
      excludedRowIds: [],
    };
    const actions = buildApplyActions(
      [row({ id: "r1" }), row({ id: "r2", productName: "제품B", commissionRate: 0.45 })],
      null,
      undefined,
      bundle
    );
    const group = actions[0].args[0] as { options: DealCreatePayload[] };
    expect(group.options[0].totalCommissionRate).toBe(50);
    expect(group.options[1].totalCommissionRate).toBe(45);
  });

  it("기존 딜에 붙이는 하위품목도 퍼센트 수치로 저장된다", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: {
        kind: "EXISTING",
        dealId: "parent-1",
        parentDealName: "기존상위딜",
        parentBrandName: null,
        parentPartnerId: null,
      },
      excludedRowIds: [],
    };
    const actions = buildApplyActions([row()], null, undefined, bundle);
    const payload = actions[0].args[0] as { options: DealCreatePayload[] };
    expect(payload.options[0].totalCommissionRate).toBe(50);
    expect(payload.options[0].discountRate).toBe(25);
  });
});

describe("기존 딜 갱신 — 비율이 퍼센트 수치로 저장된다", () => {
  it("MAPPED 행의 updateDeal 페이로드도 변환된다", () => {
    const action = buildApplyActionForRow(
      row({ mappingStatus: "MAPPED", mappedDealId: "deal-1" }),
      null
    );
    const data = action!.args[1] as Record<string, unknown>;
    expect(data.totalCommissionRate).toBe(50);
    expect(data.discountRate).toBe(25);
  });

  it("비율이 없는 행은 해당 키를 넣지 않는다", () => {
    const action = buildApplyActionForRow(
      row({ mappingStatus: "MAPPED", mappedDealId: "deal-1", commissionRate: null, discountRate: null }),
      null
    );
    const data = action!.args[1] as Record<string, unknown>;
    expect("totalCommissionRate" in data).toBe(false);
    expect("discountRate" in data).toBe(false);
  });
});

describe("회귀 방지 — 0~1 구간 값이 딜로 새어나가지 않는다", () => {
  it("모든 반영 경로의 비율 페이로드는 1 미만이 아니다(0 제외)", () => {
    const bundle: BundlePolicy = {
      mode: "BUNDLE",
      target: { kind: "NEW", parentDealName: "묶음딜" },
      excludedRowIds: [],
    };
    const collected: Array<number | null | undefined> = [];
    const visit = (p: DealCreatePayload) => {
      collected.push(p.totalCommissionRate, p.discountRate);
    };

    for (const actions of [
      buildApplyActions([row()], null),
      buildApplyActions([row({ id: "a" }), row({ id: "b", productName: "제품B" })], null, undefined, bundle),
    ]) {
      for (const action of actions) {
        if (action.method === "createDeal") visit(action.args[0]);
        else if (action.method === "createDealGroup") {
          visit(action.args[0].parent);
          action.args[0].options.forEach(visit);
        } else if (action.method === "attachDealOptions") {
          action.args[0].options.forEach(visit);
        }
      }
    }

    expect(collected.length).toBeGreaterThan(0);
    for (const rate of collected) {
      if (rate === null || rate === undefined || rate === 0) continue;
      expect(rate).toBeGreaterThanOrEqual(1);
    }
  });
});
