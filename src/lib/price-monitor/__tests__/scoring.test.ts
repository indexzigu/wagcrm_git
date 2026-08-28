import { describe, it, expect } from "vitest";
import { scoreCandidate, computeOurUnitPrice } from "../scoring";

describe("scoreCandidate", () => {
  it("완전히 다른 상품명은 낮은 점수를 받는다", () => {
    const result = scoreCandidate(
      { productName: "삼성 갤럭시 버즈", price: 100000, totalPrice: 100000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(result.matchScore).toBeLessThan(40);
  });

  it("유사한 상품명은 높은 점수를 받는다", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드 4박스", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(result.matchScore).toBeGreaterThanOrEqual(40);
  });

  it("수량 불일치 시 페널티가 적용된다", () => {
    const matched = scoreCandidate(
      { productName: "종근당 락토핏 골드 4박스", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", expectedUnit: "박스", expectedQuantity: 4 },
    );
    const mismatched = scoreCandidate(
      { productName: "종근당 락토핏 골드 2박스", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", expectedUnit: "박스", expectedQuantity: 4 },
    );
    expect(mismatched.matchScore).toBeLessThan(matched.matchScore);
  });

  it("단위가격을 정규화한다 (totalPrice/qty)", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드 4박스", price: 40000, totalPrice: 40000 },
      { targetQuery: "종근당 락토핏 골드", expectedUnit: "박스", expectedQuantity: 4 },
    );
    expect(result.unitPrice).toBe(10000);
  });

  it("수량 정보가 전혀 없으면 unitPrice는 null", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드", price: 40000, totalPrice: 40000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(result.unitPrice).toBeNull();
  });
});

describe("computeOurUnitPrice", () => {
  it("수량이 있으면 총가/수량", () => {
    expect(computeOurUnitPrice(40000, 4)).toBe(10000);
  });
  it("수량이 없거나 0이면 null", () => {
    expect(computeOurUnitPrice(40000, null)).toBeNull();
    expect(computeOurUnitPrice(40000, 0)).toBeNull();
  });
});

describe("scoreCandidate — modelName 토큰 가중 (P3-1)", () => {
  it("후보 상품명에 모델 토큰이 포함되면 +30 보너스가 적용된다", () => {
    const withoutModel = scoreCandidate(
      { productName: "종근당 락토핏 골드", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    const withModel = scoreCandidate(
      { productName: "종근당 락토핏 골드 PB-10000X", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    expect(withModel.matchScore).toBe(Math.min(100, withoutModel.matchScore + 30));
  });

  it("보너스 적용 후 100을 초과하지 않는다 (clamp)", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드 PB-10000X", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    expect(result.matchScore).toBeLessThanOrEqual(100);
  });

  it("모델 토큰이 후보 상품명에 없으면 페널티 없이 기존 점수 그대로다", () => {
    const withoutModel = scoreCandidate(
      { productName: "종근당 락토핏 골드", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    const modelMissing = scoreCandidate(
      { productName: "종근당 락토핏 골드", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    expect(modelMissing.matchScore).toBe(withoutModel.matchScore);
  });

  it("하이픈-공백 정규화 후 매치된다 ('PB-10000X' 모델 vs 'PB 10000X' 상품명 표기)", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드 PB 10000X 정품", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    const baseline = scoreCandidate(
      { productName: "종근당 락토핏 골드 정품", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(result.matchScore).toBeGreaterThan(baseline.matchScore);
  });

  it("대소문자 무시하고 매치된다", () => {
    const result = scoreCandidate(
      { productName: "종근당 락토핏 골드 pb-10000x", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    const baseline = scoreCandidate(
      { productName: "종근당 락토핏 골드", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(result.matchScore).toBe(Math.min(100, baseline.matchScore + 30));
  });

  it("정규화 후 모델 토큰 길이가 3 미만이면 스킵된다 (우연 매치 방지)", () => {
    const withShortModel = scoreCandidate(
      { productName: "종근당 락토핏 골드 AX 세트", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "AX" },
    );
    const baseline = scoreCandidate(
      { productName: "종근당 락토핏 골드 AX 세트", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(withShortModel.matchScore).toBe(baseline.matchScore);
  });

  it("modelName이 null/undefined이면 기존 동작과 완전히 동일하다 (회귀 금지)", () => {
    const withNull = scoreCandidate(
      { productName: "종근당 락토핏 골드 4박스", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: null },
    );
    const withUndefined = scoreCandidate(
      { productName: "종근당 락토핏 골드 4박스", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(withNull.matchScore).toBe(withUndefined.matchScore);
  });

  it("[Major 2 회귀] 숫자 전용 모델명 '10000'이 가격 표기('10000원')의 substring에 오탐하지 않는다", () => {
    const withModel = scoreCandidate(
      { productName: "저가몰 무선고데기 10000원 특가", price: 10000, totalPrice: 10000 },
      { targetQuery: "휴브론 무선고데기", modelName: "10000" },
    );
    const baseline = scoreCandidate(
      { productName: "저가몰 무선고데기 10000원 특가", price: 10000, totalPrice: 10000 },
      { targetQuery: "휴브론 무선고데기" },
    );
    expect(withModel.matchScore).toBe(baseline.matchScore);
  });

  it("[Major 2] 숫자 전용 모델명 '10000'이 독립 토큰으로 등장하면(정당한 모델 표기) 보너스가 적용된다", () => {
    const withModel = scoreCandidate(
      { productName: "파워뱅크 10000 블랙", price: 30000, totalPrice: 30000 },
      { targetQuery: "파워브랜드 파워뱅크", modelName: "10000" },
    );
    const baseline = scoreCandidate(
      { productName: "파워뱅크 10000 블랙", price: 30000, totalPrice: 30000 },
      { targetQuery: "파워브랜드 파워뱅크" },
    );
    expect(withModel.matchScore).toBe(Math.min(100, baseline.matchScore + 30));
  });

  it("[Major 2 회귀] 영숫자 혼합 모델('PB-10000X')은 숫자 경계 가드의 영향을 받지 않고 기존처럼 매치된다", () => {
    const withModel = scoreCandidate(
      { productName: "종근당 락토핏 골드 PB-10000X", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드", modelName: "PB-10000X" },
    );
    const baseline = scoreCandidate(
      { productName: "종근당 락토핏 골드 PB-10000X", price: 30000, totalPrice: 30000 },
      { targetQuery: "종근당 락토핏 골드" },
    );
    expect(withModel.matchScore).toBe(Math.min(100, baseline.matchScore + 30));
  });
});
