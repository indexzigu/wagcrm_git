import { describe, expect, it } from "vitest";
import {
  groupSettlementItemsByZone,
  hasProfitAdjustment,
  normalizeSettlementItemMode,
  resolveAdjustedOperatingProfit,
  resolveSellerFeeBasis,
  resolveSettlementItemSignedAmount,
  resolveSettlementZone,
  sumBrandItems,
  sumBrandPaidItems,
  sumInternalItems,
  sumSellerPayoutItems,
  type SettlementItemInput,
} from "../settlement-items";

/** 설계 문서의 조합표(§2-2)를 그대로 픽스처로 옮긴 것 — 표가 바뀌면 여기가 먼저 깨진다. */
const 반품배송비: SettlementItemInput = {
  invoiceMode: "PURCHASE_RECEIVE",
  counterparty: "BRAND",
  amount: 60_000,
};
const 이벤트구매비용: SettlementItemInput = {
  invoiceMode: "SALES_ISSUE",
  counterparty: "BRAND",
  amount: 330_000,
};
const 광고비_브랜드수취: SettlementItemInput = {
  invoiceMode: "SALES_ISSUE",
  counterparty: "BRAND",
  amount: 550_000,
};
const 광고비_셀러지급_개인: SettlementItemInput = {
  invoiceMode: "NO_INVOICE",
  counterparty: "SELLER",
  amount: 550_000,
};
const 광고비_셀러지급_사업자: SettlementItemInput = {
  invoiceMode: "PURCHASE_RECEIVE",
  counterparty: "SELLER",
  amount: 550_000,
};
const 잡이익: SettlementItemInput = {
  invoiceMode: "NO_INVOICE",
  counterparty: "INTERNAL",
  amount: 60_000,
};

describe("resolveSettlementItemSignedAmount — 부호는 방식이 정한다", () => {
  it("매출계산서 발행은 받을 돈이라 +", () => {
    expect(resolveSettlementItemSignedAmount(이벤트구매비용)).toBe(330_000);
  });

  it("매입계산서 수취는 낼 돈이라 −", () => {
    expect(resolveSettlementItemSignedAmount(반품배송비)).toBe(-60_000);
  });

  it("계산서 없음 × 셀러는 지급이라 −", () => {
    expect(resolveSettlementItemSignedAmount(광고비_셀러지급_개인)).toBe(-550_000);
  });

  it("계산서 없음 × 자사는 입력 금액의 부호가 곧 방향이다", () => {
    expect(resolveSettlementItemSignedAmount(잡이익)).toBe(60_000);
    expect(resolveSettlementItemSignedAmount({ ...잡이익, amount: -25_000 })).toBe(-25_000);
  });

  it("음수 입력은 역방향 정정이다 — 수정세금계산서·반품 조정 차감을 담는 통로", () => {
    // 매입계산서 수취(기본 −)에 음수를 넣으면 +로 뒤집힌다. 버그가 아니라 의도된 동작.
    expect(resolveSettlementItemSignedAmount({ ...반품배송비, amount: -60_000 })).toBe(60_000);
  });
});

describe("resolveSettlementZone — 대상이 곧 구간이다", () => {
  it("세 대상이 각자 구간으로 간다", () => {
    expect(resolveSettlementZone(반품배송비)).toBe("BRAND");
    expect(resolveSettlementZone(광고비_셀러지급_개인)).toBe("SELLER");
    expect(resolveSettlementZone(잡이익)).toBe("INTERNAL");
  });

  it("groupSettlementItemsByZone 은 빈 구간도 키를 유지한다(화면이 length 로 판정)", () => {
    const grouped = groupSettlementItemsByZone([반품배송비]);
    expect(grouped.BRAND).toHaveLength(1);
    expect(grouped.SELLER).toEqual([]);
    expect(grouped.INTERNAL).toEqual([]);
  });
});

describe("normalizeSettlementItemMode — 금지 조합 서버 정규화", () => {
  it("대상이 자사면 방식을 NO_INVOICE 로 강제한다", () => {
    // UI 는 자동 전환·비활성으로 막지만, API 직접 호출은 클라이언트를 우회한다.
    expect(normalizeSettlementItemMode("INTERNAL", "PURCHASE_RECEIVE")).toBe("NO_INVOICE");
    expect(normalizeSettlementItemMode("INTERNAL", "SALES_ISSUE")).toBe("NO_INVOICE");
  });

  it("브랜드·셀러 대상은 선택한 방식을 그대로 둔다", () => {
    expect(normalizeSettlementItemMode("BRAND", "SALES_ISSUE")).toBe("SALES_ISSUE");
    expect(normalizeSettlementItemMode("SELLER", "NO_INVOICE")).toBe("NO_INVOICE");
  });
});

describe("구간 합계", () => {
  const items = [반품배송비, 광고비_브랜드수취, 광고비_셀러지급_개인, 잡이익];

  it("브랜드사 합은 부호를 섞어 계산한다", () => {
    expect(sumBrandItems(items)).toBe(-60_000 + 550_000);
  });

  it("셀러 지급 합은 양수 어휘로 돌려준다", () => {
    expect(sumSellerPayoutItems(items)).toBe(550_000);
  });

  it("셀러 대상이지만 우리가 청구하는 행은 지급액을 줄인다", () => {
    const 셀러청구: SettlementItemInput = {
      invoiceMode: "SALES_ISSUE",
      counterparty: "SELLER",
      amount: 100_000,
    };
    expect(sumSellerPayoutItems([광고비_셀러지급_개인, 셀러청구])).toBe(550_000 - 100_000);
  });

  it("자사 합은 잡이익 +, 기타 비용 −", () => {
    expect(sumInternalItems([잡이익, { ...잡이익, amount: -10_000 }])).toBe(50_000);
  });

  it("사업자 셀러 지급(매입계산서 수취)도 같은 지급 합에 들어간다", () => {
    expect(sumSellerPayoutItems([광고비_셀러지급_사업자])).toBe(550_000);
  });
});

describe("조정 후 손익 — 상계는 양쪽 다리가 다 있어야 성립한다", () => {
  it("브랜드사에 낸 부대비용과 자사 잡이익이 상계되면 손익이 그대로다", () => {
    // 반품배송비 60,000 을 브랜드사에 내고 소비자에게 현금 60,000 을 받은 상황.
    // 잡이익만 더하면 60,000 만큼 과대표시된다 — 그래서 양쪽 다리를 다 넣는다.
    const adjusted = resolveAdjustedOperatingProfit(980_000, [반품배송비, 잡이익]);
    expect(adjusted).toBe(980_000);
  });

  it("상계 없이 비용만 있으면 손익이 줄어든다", () => {
    expect(resolveAdjustedOperatingProfit(980_000, [반품배송비])).toBe(920_000);
  });

  it("브랜드사에서 받는 항목(발행)은 손익 조정에 넣지 않는다", () => {
    // 매출 부대비용은 실비 청구라 마진 0 — 조정 후 손익을 움직이면 안 된다.
    expect(resolveAdjustedOperatingProfit(980_000, [이벤트구매비용])).toBe(980_000);
  });

  it("셀러 지급 항목도 손익 조정에 넣지 않는다(전달분, 마진 0)", () => {
    expect(resolveAdjustedOperatingProfit(980_000, [광고비_셀러지급_개인])).toBe(980_000);
  });

  it("sumBrandPaidItems 는 지급 방향만 양수로 집계한다", () => {
    expect(sumBrandPaidItems([반품배송비, 광고비_브랜드수취])).toBe(60_000);
  });

  it("hasProfitAdjustment 는 조정이 실제로 있을 때만 참", () => {
    expect(hasProfitAdjustment([])).toBe(false);
    expect(hasProfitAdjustment([이벤트구매비용])).toBe(false);
    expect(hasProfitAdjustment([반품배송비])).toBe(true);
    expect(hasProfitAdjustment([잡이익])).toBe(true);
  });
});

describe("resolveSellerFeeBasis — 정산 기준액(오너 정정 2026-08-27)", () => {
  // 「정산 기준액」은 판매대행비 자체가 아니라 그것을 계산할 때 곱하는 매출액이다.
  // 기준은 세무 유형이 가른다 — 그래서 종전 화면 문구 「총 거래액 × 셀러수수료율」은
  // 개인 셀러에게 사실이 아니었다.
  it("개인 셀러의 기준은 공급가액(부가세 제외)이다", () => {
    const basis = resolveSellerFeeBasis(38_900_000, true);
    expect(basis.amount).toBe(35_363_636); // 38,900,000 ÷ 1.1
    expect(basis.label).toContain("공급가액");
  });

  it("사업자 셀러의 기준은 총 거래액이다", () => {
    const basis = resolveSellerFeeBasis(38_900_000, false);
    expect(basis.amount).toBe(38_900_000);
    expect(basis.label).toContain("총 거래액");
    expect(basis.label).not.toContain("공급가액");
  });

  // 금액과 이름이 한 함수에서 나와야 "공급가액을 찍으면서 총 거래액이라고 말하는" 상태가
  // 만들어지지 않는다 — 이름만 따로 만드는 호출부가 생기면 이 단언이 먼저 깨진다.
  it("이름은 「고정」 태그가 무엇에 대한 것인지까지 말한다", () => {
    expect(resolveSellerFeeBasis(1_000_000, true).label).toContain("부가 항목 무관");
    expect(resolveSellerFeeBasis(1_000_000, false).label).toContain("부가 항목 무관");
  });
});
