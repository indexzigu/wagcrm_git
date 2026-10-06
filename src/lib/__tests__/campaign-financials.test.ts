import { describe, expect, it } from "vitest";

import {
  SELLER_FEE_BASIS_MIXED_RATE_MESSAGE,
  allocateByWeight,
  calculateDerivedCampaignFinancials,
  resolveIndividualWithholding,
  resolveDisplaySellerFee,
  resolveEffectiveSellerFeeBasis,
  resolveSellerFee,
  resolveSellerFeeBasisEligibility,
} from "../campaign-financials";

describe("calculateDerivedCampaignFinancials", () => {
  it("recalculates withholding tax and final operating profit from gross sales", () => {
    expect(
      calculateDerivedCampaignFinancials({
        actualSales: 800_000,
        operatingExpense: 10_000,
        miscExpense: 2_000,
        totalMarginRate: 30,
        sellerMarginRate: 10,
        sellerTaxType: "BUSINESS",
      }),
    ).toEqual({
      settlementSales: 240_000,
      sellerExpense: 80_000,
      taxExpense: 14_545,
      operatingProfit: 133_455,
    });
  });

  it("recalculates withholding tax and final operating profit for INDIVIDUAL tax type", () => {
    expect(
      calculateDerivedCampaignFinancials({
        actualSales: 800_000,
        operatingExpense: 10_000,
        miscExpense: 2_000,
        totalMarginRate: 30,
        sellerMarginRate: 10,
        sellerTaxType: "INDIVIDUAL",
      }),
    ).toEqual({
      settlementSales: 240_000,
      sellerExpense: 72_727,
      // 원천세 = 셀러 지급액 × 3.3% = round(72,727 × 0.033) = 2,400 (오너 확정 2026-10-05 — 지급액을
      // 다시 ÷1.1 하면 2,182 가 되던 종전 식은 틀렸다) + 수수료 부가세 round(240,000 − 240,000/1.1) = 21,818
      taxExpense: 24_218,
      operatingProfit: 131_055,
    });
  });
});

describe("resolveIndividualWithholding", () => {
  it("지급액이 수동이면 그 수동 지급액 × 3.3% 를 쓴다", () => {
    expect(
      resolveIndividualWithholding({ isManualSellerExpense: true, sellerExpense: 70_000, autoWithholdingSum: 3_000 }),
    ).toBe(2_310);
  });

  it("지급액이 자동이면 품목별 자동 합계를 그대로 쓴다", () => {
    expect(
      resolveIndividualWithholding({ isManualSellerExpense: false, sellerExpense: 70_000, autoWithholdingSum: 3_000 }),
    ).toBe(3_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 수동 정산 기준액(오너 확정 2026-10-06). 금액은 전부 가공 — 실데이터 아님(P0).
// 실사례 모양: 총 거래액 10,000,000 중 우리가 직접 판 400,000 은 셀러 수수료가 없다 →
// 운영자가 기준액을 9,600,000 으로 넣는다.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSellerFee — 수동 판매대행비 > 수동 기준액 > 자동", () => {
  const AUTO = { autoSellerExpense: 1_000_000, autoWithholdingSum: 33_000 };

  it("기준액이 없으면 자동값 그대로", () => {
    expect(
      resolveSellerFee({
        ...AUTO,
        sellerFeeBasisOverride: null,
        overrideSellerRate: 10,
        isManualSellerExpense: false,
        manualSellerExpense: null,
      }),
    ).toEqual({ sellerExpense: 1_000_000, individualWithholding: 33_000, source: "AUTO" });
  });

  it("기준액이 있으면 판매대행비 = round(기준액 × 요율), 원천세 = round(판매대행비 × 3.3%)", () => {
    expect(
      resolveSellerFee({
        ...AUTO,
        sellerFeeBasisOverride: 9_600_000,
        overrideSellerRate: 10,
        isManualSellerExpense: false,
        manualSellerExpense: null,
      }),
    ).toEqual({ sellerExpense: 960_000, individualWithholding: 31_680, source: "BASIS_OVERRIDE" });
  });

  it("반올림은 round — 소수 요율에서도 원 단위로 떨어진다", () => {
    const fee = resolveSellerFee({
      ...AUTO,
      sellerFeeBasisOverride: 1_234_567,
      overrideSellerRate: 7.5,
      isManualSellerExpense: false,
      manualSellerExpense: null,
    });
    expect(fee.sellerExpense).toBe(Math.round((1_234_567 * 7.5) / 100));
    expect(fee.individualWithholding).toBe(Math.round(fee.sellerExpense * 0.033));
  });

  it("0 은 유효한 수동값이다(전량 자체 판매 → 판매대행비 0)", () => {
    expect(
      resolveSellerFee({
        ...AUTO,
        sellerFeeBasisOverride: 0,
        overrideSellerRate: 10,
        isManualSellerExpense: false,
        manualSellerExpense: null,
      }),
    ).toEqual({ sellerExpense: 0, individualWithholding: 0, source: "BASIS_OVERRIDE" });
  });

  it("수동 판매대행비가 기준액을 이긴다", () => {
    expect(
      resolveSellerFee({
        ...AUTO,
        sellerFeeBasisOverride: 9_600_000,
        overrideSellerRate: 10,
        isManualSellerExpense: true,
        manualSellerExpense: 500_000,
      }),
    ).toEqual({ sellerExpense: 500_000, individualWithholding: 16_500, source: "MANUAL_SELLER_EXPENSE" });
  });

  it("요율 자격이 없으면(overrideSellerRate=null) 틀린 요율로 곱하지 않고 자동으로 내려간다", () => {
    expect(
      resolveSellerFee({
        ...AUTO,
        sellerFeeBasisOverride: 9_600_000,
        overrideSellerRate: null,
        isManualSellerExpense: false,
        manualSellerExpense: null,
      }).source,
    ).toBe("AUTO");
  });
});

describe("resolveSellerFeeBasisEligibility — 요율이 하나로 정해질 때만 수동 기준액", () => {
  it("품목 0개 → 캠페인 요율", () => {
    expect(resolveSellerFeeBasisEligibility({ deals: [], campaignSellerMarginRate: 12 })).toEqual({
      eligible: true,
      sellerRate: 12,
    });
  });

  it("품목 1개 → 그 품목의 실효 요율(딜 요율 ?? 캠페인 요율)", () => {
    expect(
      resolveSellerFeeBasisEligibility({ deals: [{ sellerMarginRate: 15 }], campaignSellerMarginRate: 12 }),
    ).toEqual({ eligible: true, sellerRate: 15 });
  });

  it("품목 여러 개라도 실효 요율이 같으면 허용(딜 요율 null 은 캠페인 요율로 본다, Decimal 문자열도 숫자로)", () => {
    expect(
      resolveSellerFeeBasisEligibility({
        deals: [{ sellerMarginRate: null }, { sellerMarginRate: "12" }, { sellerMarginRate: { toString: () => "12.00" } }],
        campaignSellerMarginRate: 12,
      }),
    ).toEqual({ eligible: true, sellerRate: 12 });
  });

  it("실효 요율이 다른 품목이 섞이면 거부 — 한국어 사유를 돌려준다", () => {
    const result = resolveSellerFeeBasisEligibility({
      deals: [{ sellerMarginRate: 10 }, { sellerMarginRate: null }],
      campaignSellerMarginRate: 12,
    });
    expect(result).toEqual({ eligible: false, reason: SELLER_FEE_BASIS_MIXED_RATE_MESSAGE });
    expect(SELLER_FEE_BASIS_MIXED_RATE_MESSAGE).toMatch(/수수료율/);
  });
});

describe("calculateDerivedCampaignFinancials — 수동 기준액(품목 없는 캠페인 경로)", () => {
  it("개인 셀러도 기준액을 ÷1.1 하지 않는다 — 입력값 그대로 × 요율", () => {
    const derived = calculateDerivedCampaignFinancials({
      actualSales: 10_000_000,
      operatingExpense: 0,
      miscExpense: 0,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      sellerTaxType: "INDIVIDUAL",
      sellerFeeBasisOverride: 9_600_000,
    });
    expect(derived.sellerExpense).toBe(960_000);
    // 원천세 = 960,000 × 3.3% = 31,680 + 수수료 부가세 round(3,000,000 − 3,000,000/1.1) = 272,727
    expect(derived.taxExpense).toBe(31_680 + 272_727);
  });

  it("기준액 미지정이면 종전 값과 같다(동작 변화 0)", () => {
    const base = {
      actualSales: 800_000,
      operatingExpense: 10_000,
      miscExpense: 2_000,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      sellerTaxType: "BUSINESS",
    };
    expect(calculateDerivedCampaignFinancials({ ...base, sellerFeeBasisOverride: null })).toEqual(
      calculateDerivedCampaignFinancials(base),
    );
  });
});

describe("allocateByWeight — 캠페인 금액을 품목 행에 나눠도 합이 맞는다", () => {
  it("비례 배분 + 최대 잔여로 합이 정확히 total", () => {
    const parts = allocateByWeight(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("가중치 합이 0 이면 첫 행에 전부", () => {
    expect(allocateByWeight(500, [0, 0])).toEqual([500, 0]);
  });
});

describe("resolveEffectiveSellerFeeBasis — 표시·셀러 대면 표면이 writer 와 같은 판정을 쓴다", () => {
  it("저장값이 없으면 null", () => {
    expect(resolveEffectiveSellerFeeBasis({ sellerFeeBasisOverride: null, deals: [], campaignSellerMarginRate: 10 })).toBeNull();
  });

  it("자격이 있으면 기준액과 단일 요율(0 과 Decimal 문자열 포함)", () => {
    expect(resolveEffectiveSellerFeeBasis({ sellerFeeBasisOverride: 0, deals: [], campaignSellerMarginRate: 10 })).toEqual({
      basis: 0,
      sellerRate: 10,
    });
    expect(
      resolveEffectiveSellerFeeBasis({ sellerFeeBasisOverride: "9600000", deals: [{ sellerMarginRate: null }], campaignSellerMarginRate: "12" }),
    ).toEqual({ basis: 9_600_000, sellerRate: 12 });
  });

  it("품목 요율이 섞이면 저장값이 있어도 null(적용되지 않음) — 표시 판매대행비도 자동으로", () => {
    const deals = [{ sellerMarginRate: 10 }, { sellerMarginRate: 20 }];
    expect(resolveEffectiveSellerFeeBasis({ sellerFeeBasisOverride: 9_600_000, deals, campaignSellerMarginRate: 10 })).toBeNull();
    expect(
      resolveDisplaySellerFee({ sellerFeeBasisOverride: 9_600_000, deals, campaignSellerMarginRate: 10, autoFee: () => 123 }),
    ).toBe(123);
  });
});
