import { describe, expect, it } from "vitest";
import { buildApplyActionForRow } from "../apply-executor";

describe("buildApplyActionForRow — 순수 payload 변환 로직", () => {
  it("MAPPED + mappedDealId 있으면 updateDeal 액션 생성", () => {
    const action = buildApplyActionForRow(
      {
        id: "row-1",
        mappingStatus: "MAPPED",
        mappedDealId: "deal-1",
        productName: "상품A",
        sellingPrice: 30900,
        supplyPrice: 7898,
        listPrice: null,
        floorPrice: null,
        commissionRate: 0.33,
        discountRate: null,
      },
      null
    );
    expect(action).not.toBeNull();
    expect(action!.method).toBe("updateDeal");
    expect(action!.args[0]).toBe("deal-1");
    expect((action!.args[1] as Record<string, unknown>).sellingPrice).toBe(30900);
  });

  it("NEW_DEAL + productName/sellingPrice 있으면 createDeal 액션 생성", () => {
    const action = buildApplyActionForRow(
      {
        id: "row-2",
        mappingStatus: "NEW_DEAL",
        mappedDealId: null,
        productName: "신규상품",
        sellingPrice: 50000,
        supplyPrice: 20000,
        listPrice: null,
        floorPrice: null,
        commissionRate: null,
        discountRate: null,
      },
      "partner-1"
    );
    expect(action).not.toBeNull();
    expect(action!.method).toBe("createDeal");
    const data = action!.args[0] as Record<string, unknown>;
    expect(data.dealName).toBe("신규상품");
    expect(data.partnerId).toBe("partner-1");
    expect(data.sellingPrice).toBe(50000);
  });

  it("NEW_DEAL인데 productName 없으면 null(생성 스킵)", () => {
    const action = buildApplyActionForRow(
      {
        id: "row-3",
        mappingStatus: "NEW_DEAL",
        mappedDealId: null,
        productName: null,
        sellingPrice: 50000,
        supplyPrice: null,
        listPrice: null,
        floorPrice: null,
        commissionRate: null,
        discountRate: null,
      },
      null
    );
    expect(action).toBeNull();
  });

  it("UNMAPPED/SUGGESTED는 반영 대상이 아니므로 null", () => {
    const suggested = buildApplyActionForRow(
      {
        id: "row-4",
        mappingStatus: "SUGGESTED",
        mappedDealId: "deal-1",
        productName: "상품",
        sellingPrice: 1000,
        supplyPrice: 500,
        listPrice: null,
        floorPrice: null,
        commissionRate: null,
        discountRate: null,
      },
      null
    );
    expect(suggested).toBeNull();
  });

  it("Deal.supplyPrice(Float) 변환 시 Decimal-like 객체도 Number로 변환된다", () => {
    const decimalLike = { toString: () => "12345.67" };
    const action = buildApplyActionForRow(
      {
        id: "row-5",
        mappingStatus: "MAPPED",
        mappedDealId: "deal-1",
        productName: "상품",
        sellingPrice: 1000,
        supplyPrice: decimalLike,
        listPrice: null,
        floorPrice: null,
        commissionRate: null,
        discountRate: null,
      },
      null
    );
    const data = action!.args[1] as Record<string, unknown>;
    expect(data.supplyPrice).toBeCloseTo(12345.67, 2);
  });
});
