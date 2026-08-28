import { describe, expect, it } from "vitest";
import { suggestMappingForRow, MAPPING_SUGGEST_THRESHOLD, type DealCandidate } from "../mapping";

describe("suggestMappingForRow — 순수 스코어링 로직", () => {
  const candidates: DealCandidate[] = [
    { id: "deal-1", dealName: "관절연골엔 뮤코다당단백 콘드로이친 60정", brandName: "Nutrione", partnerId: "p1" },
    { id: "deal-2", dealName: "루테인지아잔틴 에이엑스 GR 30캡슐", brandName: "Nutrione", partnerId: "p1" },
  ];

  it("이름이 충분히 유사하면 SUGGESTED + bestDealId", () => {
    const result = suggestMappingForRow(
      { productName: "관절연골엔 뮤코다당단백 콘드로이친(공용,60정), 1", optionName: null },
      candidates
    );
    expect(result.status).toBe("SUGGESTED");
    expect(result.bestDealId).toBe("deal-1");
    expect(result.bestScore).toBeGreaterThanOrEqual(MAPPING_SUGGEST_THRESHOLD);
  });

  it("전혀 유사하지 않으면 NEW_DEAL, bestDealId=null", () => {
    const result = suggestMappingForRow({ productName: "완전히 다른 제품명 XYZ", optionName: null }, candidates);
    expect(result.status).toBe("NEW_DEAL");
    expect(result.bestDealId).toBeNull();
  });

  it("후보가 없으면 NEW_DEAL", () => {
    const result = suggestMappingForRow({ productName: "아무거나", optionName: null }, []);
    expect(result.status).toBe("NEW_DEAL");
    expect(result.candidates).toHaveLength(0);
  });

  it("candidates는 점수 내림차순 상위 5개까지만 반환", () => {
    const many: DealCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      id: `deal-${i}`,
      dealName: `관절연골엔 뮤코다당단백 콘드로이친 상품 ${i}`,
      brandName: null,
      partnerId: null,
    }));
    const result = suggestMappingForRow(
      { productName: "관절연골엔 뮤코다당단백 콘드로이친", optionName: null },
      many
    );
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });
});
