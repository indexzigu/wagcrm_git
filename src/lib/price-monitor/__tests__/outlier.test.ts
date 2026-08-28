import { describe, it, expect } from "vitest";
import { filterOutliers, detectOutlierReason, PRICE_BAND, MATCH_FLOOR } from "../outlier";
import type { ScoredCandidate } from "../scoring";

function candidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    productName: "정상 상품",
    price: 10000,
    totalPrice: 10000,
    matchScore: 80,
    extractedQuantity: null,
    unitPrice: null,
    ...overrides,
  };
}

describe("detectOutlierReason", () => {
  it("EXCLUDE_KW 키워드가 포함되면 배제한다", () => {
    const c = candidate({ productName: "중고 락토핏 골드" });
    expect(detectOutlierReason(c, { ourTotalPrice: 10000 })).toBe("EXCLUDE_KEYWORD");
  });

  it("해외직구/리퍼/렌탈/반품/파손 키워드도 모두 배제한다", () => {
    for (const kw of ["해외직구", "리퍼", "렌탈", "반품", "파손"]) {
      const c = candidate({ productName: `${kw} 상품` });
      expect(detectOutlierReason(c, { ourTotalPrice: 10000 })).toBe("EXCLUDE_KEYWORD");
    }
  });

  it(`매치점수가 MATCH_FLOOR(${MATCH_FLOOR}) 미만이면 배제한다`, () => {
    const c = candidate({ matchScore: 39 });
    expect(detectOutlierReason(c, { ourTotalPrice: 10000 })).toBe("MATCH_TOO_LOW");
  });

  it(`가격이 ±${PRICE_BAND * 100}% 밴드 아래로 벗어나면 배제한다`, () => {
    // 우리 가격 10000원, 밴드 20% → 8000원 미만은 배제
    const tooCheap = candidate({ totalPrice: 7999 });
    expect(detectOutlierReason(tooCheap, { ourTotalPrice: 10000 })).toBe("PRICE_BAND_VIOLATION");

    const withinBand = candidate({ totalPrice: 8000 });
    expect(detectOutlierReason(withinBand, { ourTotalPrice: 10000 })).toBeNull();
  });

  it("가격이 우리보다 비싼 경우는 밴드 위반이 아니다(진짜 최저가 경쟁력 위험을 가려서는 안 됨)", () => {
    const expensive = candidate({ totalPrice: 50000 });
    expect(detectOutlierReason(expensive, { ourTotalPrice: 10000 })).toBeNull();
  });

  it("수량 불일치는 배제한다", () => {
    const c = candidate({ extractedQuantity: 2 });
    expect(detectOutlierReason(c, { ourTotalPrice: 10000, expectedQuantity: 4 })).toBe(
      "QUANTITY_MISMATCH",
    );
  });

  it("수량 정보가 없으면(추출 실패) 수량 불일치로 배제하지 않는다", () => {
    const c = candidate({ extractedQuantity: null });
    expect(detectOutlierReason(c, { ourTotalPrice: 10000, expectedQuantity: 4 })).toBeNull();
  });

  it("모든 조건을 통과하면 null", () => {
    const c = candidate();
    expect(detectOutlierReason(c, { ourTotalPrice: 10000 })).toBeNull();
  });
});

describe("filterOutliers", () => {
  it("배제분도 excludeReason과 함께 결과에 보존한다(오배제 감사)", () => {
    const list = [
      candidate({ productName: "정상 A" }),
      candidate({ productName: "중고 B" }),
    ];
    const { valid, excluded } = filterOutliers(list, { ourTotalPrice: 10000 });
    expect(valid).toHaveLength(1);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].excludeReason).toBe("EXCLUDE_KEYWORD");
    expect(excluded[0].productName).toBe("중고 B"); // 원본 필드 보존
  });
});
