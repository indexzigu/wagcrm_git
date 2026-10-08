import { describe, expect, it } from "vitest";
import {
  buildMonthlyBackfillLine,
  type MonthlyBackfillSource,
} from "../monthly-settlement-backfill";
import { rollupMonthlyGoodsCost } from "../monthly-settlement";

// 금액·날짜는 전부 가공이다(P0 — 공개 레포에 운영 실측치를 넣지 않는다).
const NOW = new Date("2026-10-08T03:00:00.000Z");
const INVOICE_DATE = new Date("2026-09-30T00:00:00.000Z");
const DUE_DATE = new Date("2026-10-10T00:00:00.000Z");
const PAID_AT = new Date("2026-10-09T00:00:00.000Z");

function source(overrides: Partial<MonthlyBackfillSource> = {}): MonthlyBackfillSource {
  return {
    // KST 2026-09-14 ~ 2026-09-20 (UTC 전날 15:00)
    startDate: new Date("2026-09-13T15:00:00.000Z"),
    endDate: new Date("2026-09-19T15:00:00.000Z"),
    salesChannel: "OWN_MALL_NAVER",
    quantity: 12,
    actualSales: 200_000,
    totalMarginRate: 40,
    settlementSales: 80_000,
    settlementGoodsCost: 110_000,
    supplierInvoiceIssuedAt: null,
    expectedDepositDate: null,
    depositReceivedAt: null,
    isDepositReceived: false,
    expectedPayoutDate: null,
    payoutCompletedAt: null,
    isPayoutCompleted: false,
    expectedSupplierPayoutDate: null,
    supplierPayoutCompletedAt: null,
    isSupplierPayoutCompleted: false,
    ...overrides,
  };
}

describe("기존 캠페인 → 월 줄 1개 이전", () => {
  it("귀속 월은 종료일의 KST 월이고 캠페인 값(수량·거래액·요율·영업수익·물품대금)은 그대로 복사한다", () => {
    const line = buildMonthlyBackfillLine(source(), NOW);
    expect(line.yearMonth).toBe("2026-09");
    expect(line.quantity).toBe(12);
    expect(line.transactionAmount).toBe(200_000);
    expect(line.commissionRate).toBe(40);
    expect(line.commissionAmount).toBe(80_000);
    expect(line.supplyAmount).toBe(72_727);
    expect(line.vat).toBe(7_273);
    expect(line.goodsAmount).toBe(110_000);
    // 지급액은 비워 둔다 — 물품대금이 지급액이 된다(복사하면 물품대금 수정이 안 따라간다).
    expect(line.paymentAmount).toBeNull();
  });

  it("KST 월말 자정 직전 종료(UTC 로는 다음 달이 아님)도 KST 달로 귀속한다", () => {
    const line = buildMonthlyBackfillLine(source({ endDate: new Date("2026-09-30T14:59:00.000Z") }), NOW);
    expect(line.yearMonth).toBe("2026-09");
    const crossed = buildMonthlyBackfillLine(source({ endDate: new Date("2026-09-30T15:00:00.000Z") }), NOW);
    expect(crossed.yearMonth).toBe("2026-10");
  });

  it("자사몰: 공급사 계산서는 매입 수취로, 공급사 지급은 전용 supplierPayout 필드에서 온다", () => {
    const line = buildMonthlyBackfillLine(
      source({
        supplierInvoiceIssuedAt: INVOICE_DATE,
        expectedSupplierPayoutDate: DUE_DATE,
        supplierPayoutCompletedAt: PAID_AT,
        isSupplierPayoutCompleted: true,
        // 셀러 지급 레그는 이 줄과 무관해야 한다(셀러 정산은 캠페인 단위).
        expectedPayoutDate: new Date("2026-11-01T00:00:00.000Z"),
      }),
      NOW,
    );
    expect(line.purchaseInvoiceReceivedAt).toEqual(INVOICE_DATE);
    expect(line.salesInvoiceIssuedAt).toBeNull();
    expect(line.paymentDueDate).toEqual(DUE_DATE);
    expect(line.paymentPaidAt).toEqual(PAID_AT);
    expect(line.purchaseInvoiceCheckedAt).toEqual(INVOICE_DATE);
    expect(line.paymentScheduleCheckedAt).toEqual(NOW);
    expect(line.paymentCompletedCheckedAt).toEqual(PAID_AT);
    expect(line.salesInvoiceCheckedAt).toBeNull();
  });

  it("셀러몰: 공급사 지급은 payout 필드에서 온다(슬롯 SSOT)", () => {
    const line = buildMonthlyBackfillLine(
      source({ salesChannel: "SELLER_MALL", expectedPayoutDate: DUE_DATE, isPayoutCompleted: false }),
      NOW,
    );
    expect(line.paymentDueDate).toEqual(DUE_DATE);
    expect(line.paymentPaidAt).toBeNull();
    expect(line.paymentCompletedCheckedAt).toBeNull();
  });

  it("브랜드몰: 공급사 계산서는 우리가 발행한 매출 계산서이고 공급사 지급 칸은 없다", () => {
    const line = buildMonthlyBackfillLine(
      source({ salesChannel: "BRAND_MALL", supplierInvoiceIssuedAt: INVOICE_DATE, expectedPayoutDate: DUE_DATE }),
      NOW,
    );
    expect(line.salesInvoiceIssuedAt).toEqual(INVOICE_DATE);
    expect(line.salesInvoiceCheckedAt).toEqual(INVOICE_DATE);
    expect(line.purchaseInvoiceReceivedAt).toBeNull();
    expect(line.paymentDueDate).toBeNull();
    expect(line.paymentScheduleCheckedAt).toBeNull();
  });

  it("완료일만 남고 완료 플래그가 꺼진 행은 지급 안 됨으로 읽는다(플래그가 정본)", () => {
    const line = buildMonthlyBackfillLine(
      source({ supplierPayoutCompletedAt: PAID_AT, isSupplierPayoutCompleted: false }),
      NOW,
    );
    expect(line.paymentPaidAt).toBeNull();
  });

  it("물품대금 3-상태를 지킨다 — 미입력(null)은 null, 0 은 0", () => {
    expect(buildMonthlyBackfillLine(source({ settlementGoodsCost: null }), NOW).goodsAmount).toBeNull();
    expect(buildMonthlyBackfillLine(source({ settlementGoodsCost: 0 }), NOW).goodsAmount).toBe(0);
  });

  it("여러 캠페인을 이전해도 물품대금·거래액 합계와 수수료율이 그대로다(명세 검증 케이스의 성질)", () => {
    // 한 캠페인에 합산하고 나머지는 0원으로 둔 종전 우회 입력도 그대로 보존돼야 한다.
    const campaigns = [
      source({ actualSales: 120_000, settlementGoodsCost: 0 }),
      source({ actualSales: 80_000, settlementGoodsCost: 0 }),
      source({ actualSales: 300_000, settlementGoodsCost: 270_000 }),
      source({ actualSales: 50_000, settlementGoodsCost: 30_000 }),
    ].map((c) => ({ ...c, totalMarginRate: 45 }));
    const lines = campaigns.map((c) => buildMonthlyBackfillLine(c, NOW));

    const goodsBefore = campaigns.reduce((sum, c) => sum + (c.settlementGoodsCost ?? 0), 0);
    const goodsAfter = lines.reduce((sum, l) => sum + (rollupMonthlyGoodsCost([l]) ?? 0), 0);
    expect(goodsAfter).toBe(goodsBefore);

    const salesBefore = campaigns.reduce((sum, c) => sum + (c.actualSales ?? 0), 0);
    expect(lines.reduce((sum, l) => sum + (l.transactionAmount ?? 0), 0)).toBe(salesBefore);
    expect(lines.every((l) => l.commissionRate === 45)).toBe(true);
  });
});
