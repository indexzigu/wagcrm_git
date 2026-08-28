import { describe, it, expect } from "vitest";
import { evaluateMarketPrice } from "../pipeline";

describe("evaluateMarketPrice", () => {
  it("이상치를 배제한 후 남은 최저가로 판정한다", () => {
    const result = evaluateMarketPrice({
      candidates: [
        { productName: "중고 락토핏 골드 4박스", price: 5000, totalPrice: 5000 }, // 배제(키워드+가격밴드)
        { productName: "종근당 락토핏 골드 4박스", price: 9500, totalPrice: 9500 }, // 유효
        { productName: "종근당 락토핏 골드 4박스", price: 12000, totalPrice: 12000 }, // 유효
      ],
      targetQuery: "종근당 락토핏 골드 4박스",
      ourTotalPrice: 10000,
      expectedUnit: "박스",
      expectedQuantity: 4,
    });

    expect(result.validCount).toBe(2);
    expect(result.minValidItem?.totalPrice).toBe(9500);
    expect(result.verdict).toBe("VIOLATED");
    expect(result.allScored.some((c) => "excludeReason" in c)).toBe(true);
  });

  it("유효 후보가 전혀 없으면 NO_DATA", () => {
    const result = evaluateMarketPrice({
      candidates: [{ productName: "전혀 다른 상품", price: 1000, totalPrice: 1000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
    });
    expect(result.verdict).toBe("NO_DATA");
    expect(result.minValidItem).toBeNull();
  });

  it("우리가 최저가면 OK", () => {
    const result = evaluateMarketPrice({
      candidates: [{ productName: "종근당 락토핏 골드", price: 15000, totalPrice: 15000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
    });
    expect(result.verdict).toBe("OK");
  });

  it("modelName이 전달되면 scoreCandidates ctx로 흘러가 매치 점수에 반영된다 (P3-2 배선)", () => {
    const withModel = evaluateMarketPrice({
      candidates: [{ productName: "종근당 락토핏 골드 PB-10000X", price: 15000, totalPrice: 15000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
      modelName: "PB-10000X",
    });
    const withoutModel = evaluateMarketPrice({
      candidates: [{ productName: "종근당 락토핏 골드 PB-10000X", price: 15000, totalPrice: 15000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
    });
    expect(withModel.allScored[0].matchScore).toBeGreaterThan(withoutModel.allScored[0].matchScore);
  });

  it("modelName이 없으면(undefined) 기존 동작과 완전히 동일하다 (회귀 금지)", () => {
    const result = evaluateMarketPrice({
      candidates: [{ productName: "종근당 락토핏 골드", price: 15000, totalPrice: 15000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
    });
    expect(result.verdict).toBe("OK");
  });

  it("최저가 후보의 일치율이 신뢰선(60) 미만이면 VIOLATED가 아니라 REVIEW로 강등한다(다른 품목 의심)", () => {
    const result = evaluateMarketPrice({
      candidates: [
        // "종근당 락토핏"만 겹침(2토큰) → matchScore 40: 유효(≥MATCH_FLOOR)이나 신뢰선 미만
        { productName: "종근당 락토핏 사과즙", price: 9000, totalPrice: 9000 },
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.allScored[0].matchScore).toBe(40);
    expect(result.minValidItem?.totalPrice).toBe(9000);
    expect(result.minConfidentItem).toBeNull();
    expect(result.verdict).toBe("REVIEW"); // 저매치 최저가 → 경고 아닌 검토
  });

  it("신뢰선 이상(고신뢰) 후보가 우리보다 싸면 VIOLATED로 확정한다", () => {
    const result = evaluateMarketPrice({
      candidates: [
        // 4토큰 전부 겹침 → matchScore 80: 신뢰선 이상
        { productName: "종근당 락토핏 골드 파워", price: 9000, totalPrice: 9000 },
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.allScored[0].matchScore).toBe(80);
    expect(result.minConfidentItem?.totalPrice).toBe(9000);
    expect(result.verdict).toBe("VIOLATED");
  });

  it("저매치가 최저가여도, 신뢰선 이상 후보가 함께 우리보다 싸면 VIOLATED다", () => {
    const result = evaluateMarketPrice({
      candidates: [
        { productName: "종근당 락토핏 사과즙", price: 8500, totalPrice: 8500 }, // 40, 최저가지만 저신뢰
        { productName: "종근당 락토핏 골드 파워", price: 9500, totalPrice: 9500 }, // 80, 고신뢰·우리보다 쌈
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.minValidItem?.totalPrice).toBe(8500);
    expect(result.minConfidentItem?.totalPrice).toBe(9500);
    expect(result.verdict).toBe("VIOLATED");
  });

  it("저매치 후보가 우리보다 비싸면 강등 대상이 아니라 OK다(강등은 위반일 때만)", () => {
    const result = evaluateMarketPrice({
      candidates: [
        { productName: "종근당 락토핏 사과즙", price: 12000, totalPrice: 12000 }, // 40, 우리보다 비쌈
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.verdict).toBe("OK");
  });
});
