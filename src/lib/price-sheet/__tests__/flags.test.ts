import { describe, expect, it } from "vitest";
import { computeRowFlags } from "../flags";

describe("computeRowFlags", () => {
  it("판매가 < 공급가면 negativeMargin=true", () => {
    const flags = computeRowFlags({ sellingPrice: 0, supplyPrice: 3223 });
    expect(flags.negativeMargin).toBe(true);
  });

  it("판매가 >= 공급가면 negativeMargin 미설정", () => {
    const flags = computeRowFlags({ sellingPrice: 30900, supplyPrice: 7898 });
    expect(flags.negativeMargin).toBeUndefined();
  });

  it("증정/사은품 키워드가 note에 있으면 giftOrBundle=true", () => {
    const flags = computeRowFlags({ note: "선착순 50명 증정" });
    expect(flags.giftOrBundle).toBe(true);
  });

  it("단독구매불가 키워드 검출", () => {
    const flags = computeRowFlags({ optionName: "단독구매불가 옵션" });
    expect(flags.singlePurchaseBlocked).toBe(true);
  });

  it("productName 없으면 missingRequiredField + needsReview", () => {
    const flags = computeRowFlags({ missingRequiredField: true });
    expect(flags.missingRequiredField).toBe(true);
    expect(flags.needsReview).toBe(true);
  });

  it("아무 플래그도 없으면 reason이 없다", () => {
    const flags = computeRowFlags({ productName: "정상 상품", sellingPrice: 1000, supplyPrice: 500 });
    expect(flags.reason).toBeUndefined();
  });
});
