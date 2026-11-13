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
      candidates: [{ productName: "종근당 락토핏 PB-10000X", price: 15000, totalPrice: 15000 }],
      targetQuery: "종근당 락토핏 골드",
      ourTotalPrice: 10000,
      modelName: "PB-10000X",
    });
    const withoutModel = evaluateMarketPrice({
      candidates: [{ productName: "종근당 락토핏 PB-10000X", price: 15000, totalPrice: 15000 }],
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
        // 상품 축: 기준 낱말 4개 중 "종근당·락토핏" 2개 → 50: 유효(≥MATCH_FLOOR)이나 신뢰선 미만
        { productName: "종근당 락토핏 사과즙", price: 9000, totalPrice: 9000 },
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.allScored[0].matchScore).toBe(50);
    expect(result.minValidItem?.totalPrice).toBe(9000);
    expect(result.minConfidentItem).toBeNull();
    expect(result.verdict).toBe("REVIEW"); // 저매치 최저가 → 경고 아닌 검토
  });

  it("신뢰선 이상(고신뢰) 후보가 우리보다 싸면 VIOLATED로 확정한다", () => {
    const result = evaluateMarketPrice({
      candidates: [
        // 기준 낱말 전부 포함 → 100: 신뢰선 이상
        { productName: "종근당 락토핏 골드 파워", price: 9000, totalPrice: 9000 },
      ],
      targetQuery: "종근당 락토핏 골드 파워",
      ourTotalPrice: 10000,
    });
    expect(result.allScored[0].matchScore).toBe(100);
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
  describe("3축 판정 — 브랜드·상품·구성 (오너 지적 2026-11-13)", () => {
    const base = {
      targetQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
      ourTotalPrice: 24100,
      expectedUnit: "박스",
      expectedQuantity: 2,
      brandIdentities: ["비비랩", "뉴트리원"],
    };

    it("다른 회사 제품은 낱말이 겹쳐도 브랜드 불일치로 배제돼 위반을 만들지 않는다", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [
          { productName: "순 유기농 올레샷 올리브 오일 레몬즙 2박스", mall: "메디트리", price: 22000, totalPrice: 22000 },
        ],
      });
      expect(result.allScored[0].excludeReason).toBe("BRAND_MISMATCH");
      expect(result.verdict).toBe("NO_DATA");
    });

    it("같은 제품이 판매처 이름으로만 회사를 드러내도 위반으로 잡는다", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [
          { productName: "유기농 올리브 엔 레몬 듀얼샷 올레샷 2박스", mall: "뉴트리원공식스토어", price: 23500, totalPrice: 23500 },
        ],
      });
      expect(result.allScored[0].brandMatch).toBe("match");
      expect(result.verdict).toBe("VIOLATED");
    });

    it("같은 브랜드의 다른 상품 라인은 상품 불일치로 배제한다", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [{ productName: "비비랩 올리브 레몬 밸런스샷 2박스", mall: "뉴트리원", price: 21000, totalPrice: 21000 }],
      });
      expect(result.allScored[0].excludeReason).toBe("MATCH_TOO_LOW");
    });

    it("오너「다른 상품」 표시는 점수와 무관하게 배제한다", () => {
      const candidate = { productName: "비비랩 올리브레몬 듀얼 올레샷 2박스", mall: "어떤몰", price: 23000, totalPrice: 23000 };
      const result = evaluateMarketPrice({
        ...base,
        candidates: [candidate],
        ownerLabels: [{ nameKey: "어떤몰|비비랩올리브레몬듀얼올레샷2박스", urlKey: null, label: "DIFFERENT" }],
      });
      expect(result.allScored[0].excludeReason).toBe("OWNER_DIFFERENT");
      expect(result.verdict).toBe("NO_DATA");
    });

    it("오너「같은 상품」 표시는 브랜드·상품 축을 면제하고 고신뢰로 본다(구성은 그대로)", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [
          { productName: "골든 듀얼 2박스", mall: "제휴몰", url: "https://shop.example.com/p/9?ref=a", price: 23000, totalPrice: 23000 },
        ],
        ownerLabels: [{ nameKey: "제휴몰|골든듀얼2박스", urlKey: null, label: "SAME" }],
      });
      expect(result.allScored[0].ownerLabel).toBe("SAME");
      expect(result.allScored[0].excludeReason).toBeUndefined();
      expect(result.verdict).toBe("VIOLATED");
    });

    it("주소 열쇠만 같은 다른 후보에는 표시가 번지지 않는다(쿠팡 제휴 주소는 쿼리를 떼면 전부 같다)", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [
          { productName: "다른 회사 레몬즙 2박스", mall: "쿠팡", url: "https://link.coupang.com/re/AFFSDP?itemId=2", price: 23000, totalPrice: 23000 },
        ],
        ownerLabels: [{ nameKey: "쿠팡|비비랩올리브레몬듀얼올레샷2박스", urlKey: "link.coupang.com/re/AFFSDP", label: "SAME" }],
      });
      expect(result.allScored[0].ownerLabel).toBeNull();
      expect(result.allScored[0].excludeReason).toBe("BRAND_MISMATCH");
    });

    it("오너「같은 상품」이어도 수량이 다르면 구성 불일치로 배제한다", () => {
      const result = evaluateMarketPrice({
        ...base,
        candidates: [{ productName: "비비랩 올리브레몬 듀얼 올레샷 1박스", mall: "x", price: 20000, totalPrice: 20000 }],
        ownerLabels: [{ nameKey: "x|비비랩올리브레몬듀얼올레샷1박스", urlKey: null, label: "SAME" }],
      });
      expect(result.allScored[0].excludeReason).toBe("QUANTITY_MISMATCH");
    });

    it("수량을 못 읽은 후보는 상품 점수 75 이상일 때만 위반 확정 근거가 된다(옛 ×0.8 감점과 같은 효과)", () => {
      const midNoQty = evaluateMarketPrice({
        ...base,
        candidates: [{ productName: "비비랩 듀얼 올레샷", mall: "x", price: 23000, totalPrice: 23000 }],
      });
      expect(midNoQty.allScored[0].matchScore).toBe(67);
      expect(midNoQty.allScored[0].extractedQuantity).toBeNull();
      expect(midNoQty.verdict).toBe("REVIEW");

      const midWithQty = evaluateMarketPrice({
        ...base,
        candidates: [{ productName: "비비랩 듀얼 올레샷 2박스", mall: "x", price: 23000, totalPrice: 23000 }],
      });
      expect(midWithQty.allScored[0].matchScore).toBe(67);
      expect(midWithQty.verdict).toBe("VIOLATED");

      const highNoQty = evaluateMarketPrice({
        ...base,
        candidates: [{ productName: "비비랩 올리브레몬 듀얼 올레샷", mall: "x", price: 23000, totalPrice: 23000 }],
      });
      expect(highNoQty.verdict).toBe("VIOLATED");
    });

    it("브랜드 이름이 하나도 없으면 브랜드 축을 쓰지 않는다(종전 동작)", () => {
      const result = evaluateMarketPrice({
        ...base,
        brandIdentities: [],
        candidates: [{ productName: "메디트리 올리브레몬 듀얼 올레샷 2박스", mall: "메디트리", price: 23000, totalPrice: 23000 }],
      });
      expect(result.allScored[0].brandMatch).toBe("unknown");
      expect(result.verdict).toBe("VIOLATED");
    });
  });
});
