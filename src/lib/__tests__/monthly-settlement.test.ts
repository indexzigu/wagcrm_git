import { describe, expect, it } from "vitest";
import {
  attributeDailyStatsToMonths,
  buildMonthlyIncompleteMessage,
  clipPeriodToMonth,
  computeMonthlyCommission,
  countMonthlyChecks,
  isMonthlyCompletionBlocked,
  nextYearMonth,
  resolveMonthlyPaymentAmount,
  resolveNextMonthToAdd,
  rollupMonthlyGoodsCost,
  splitMonthlyCommission,
  summarizeMonthlySettlements,
  type MonthlySettlementLine,
} from "../monthly-settlement";

// 금액은 전부 가공이다(P0 — 공개 레포에 운영 실측치를 넣지 않는다).

function line(overrides: Partial<MonthlySettlementLine> = {}): MonthlySettlementLine {
  return {
    id: "l1",
    campaignId: "c1",
    yearMonth: "2026-09",
    periodStart: null,
    periodEnd: null,
    quantity: null,
    transactionAmount: null,
    commissionRate: null,
    commissionAmount: null,
    supplyAmount: null,
    vat: null,
    salesInvoiceIssuedAt: null,
    salesInvoiceNo: null,
    salesInvoiceItemName: null,
    purchaseInvoiceReceivedAt: null,
    goodsAmount: null,
    paymentAmount: null,
    paymentDueDate: null,
    paymentPaidAt: null,
    salesInvoiceCheckedAt: null,
    purchaseInvoiceCheckedAt: null,
    paymentScheduleCheckedAt: null,
    paymentCompletedCheckedAt: null,
    memo: null,
    ...overrides,
  };
}

const ALL_CHECKED = {
  salesInvoiceCheckedAt: "2026-10-01",
  purchaseInvoiceCheckedAt: "2026-10-02",
  paymentScheduleCheckedAt: "2026-10-03",
  paymentCompletedCheckedAt: "2026-10-04",
};

describe("귀속 월 계산", () => {
  it("다음 달은 연도를 넘긴다", () => {
    expect(nextYearMonth("2026-09")).toBe("2026-10");
    expect(nextYearMonth("2026-12")).toBe("2027-01");
  });

  it("캠페인 기간을 그 달로 자른다 — 월을 넘는 회차는 두 달에 나뉜다", () => {
    expect(clipPeriodToMonth("2026-09-28", "2026-10-04", "2026-09")).toEqual({
      periodStart: "2026-09-28",
      periodEnd: "2026-09-30",
    });
    expect(clipPeriodToMonth("2026-09-28", "2026-10-04", "2026-10")).toEqual({
      periodStart: "2026-10-01",
      periodEnd: "2026-10-04",
    });
  });

  it("그 달에 걸치지 않으면 기간을 비운다", () => {
    expect(clipPeriodToMonth("2026-09-01", "2026-09-10", "2026-11")).toEqual({
      periodStart: null,
      periodEnd: null,
    });
  });

  it("추가할 달 — 캠페인 기간 중 줄이 없는 가장 이른 달(이전된 종료월 줄의 앞 달을 나눈다)", () => {
    expect(resolveNextMonthToAdd([], "2026-09-28", "2026-10-04")).toBe("2026-09");
    expect(resolveNextMonthToAdd([{ yearMonth: "2026-10" }], "2026-09-28", "2026-10-04")).toBe("2026-09");
    expect(resolveNextMonthToAdd([{ yearMonth: "2026-09" }], "2026-09-28", "2026-10-04")).toBe("2026-10");
  });

  it("캠페인 기간의 모든 달에 줄이 있으면 더 추가할 달이 없다(종료월 뒤는 만들지 않는다)", () => {
    expect(
      resolveNextMonthToAdd([{ yearMonth: "2026-09" }, { yearMonth: "2026-10" }], "2026-09-28", "2026-10-04"),
    ).toBeNull();
    expect(resolveNextMonthToAdd([], "2026-12-28", "2027-01-03")).toBe("2026-12");
  });
});

describe("수수료·지급액", () => {
  it("수수료액은 캠페인 영업수익과 같은 식(floor)이고 VAT 분해는 vat.ts 를 따른다", () => {
    expect(computeMonthlyCommission(333_333, 45)).toBe(149_999);
    expect(computeMonthlyCommission(null, 45)).toBeNull();
    expect(splitMonthlyCommission(110_000)).toEqual({ supplyAmount: 100_000, vat: 10_000 });
    expect(splitMonthlyCommission(null)).toEqual({ supplyAmount: null, vat: null });
  });

  it("지급액이 비면 물품대금을 지급액으로 본다", () => {
    expect(resolveMonthlyPaymentAmount({ paymentAmount: null, goodsAmount: 50_000 })).toBe(50_000);
    expect(resolveMonthlyPaymentAmount({ paymentAmount: 40_000, goodsAmount: 50_000 })).toBe(40_000);
    expect(resolveMonthlyPaymentAmount({ paymentAmount: null, goodsAmount: null })).toBeNull();
  });
});

describe("완료 게이트", () => {
  it("월정산이 아니면 막지 않는다(기존 동작)", () => {
    expect(isMonthlyCompletionBlocked({ monthlySettlementEnabled: false, lines: [] })).toBe(false);
  });

  it("줄이 0개면 막는다 — 비어 있음을 「전부 끝남」으로 읽지 않는다", () => {
    expect(isMonthlyCompletionBlocked({ monthlySettlementEnabled: true, lines: [] })).toBe(true);
  });

  it("한 달이라도 4/4 가 아니면 막고, 모든 달이 4/4 면 통과한다", () => {
    const done = line({ ...ALL_CHECKED });
    const partial = line({ yearMonth: "2026-10", salesInvoiceCheckedAt: "2026-10-05" });
    expect(countMonthlyChecks(partial)).toBe(1);
    expect(isMonthlyCompletionBlocked({ monthlySettlementEnabled: true, lines: [done, partial] })).toBe(true);
    expect(
      isMonthlyCompletionBlocked({
        monthlySettlementEnabled: true,
        lines: [done, line({ yearMonth: "2026-10", ...ALL_CHECKED })],
      }),
    ).toBe(false);
  });

  it("막힌 사유는 남은 달을 이름과 칸 수로 말한다", () => {
    const message = buildMonthlyIncompleteMessage([
      line({ yearMonth: "2026-10", salesInvoiceCheckedAt: "2026-10-05", purchaseInvoiceCheckedAt: "2026-10-06" }),
      line({ yearMonth: "2026-09", ...ALL_CHECKED }),
    ]);
    expect(message).toContain("10월분(2/4)");
    expect(message).not.toContain("9월분");
    expect(buildMonthlyIncompleteMessage([])).toContain("줄이 없어");
  });
});

describe("물품대금 롤업", () => {
  it("값이 있는 줄만 더하고, 전부 비면 null(공식 추정 상태 유지)", () => {
    expect(rollupMonthlyGoodsCost([{ goodsAmount: 30_000 }, { goodsAmount: 20_000 }])).toBe(50_000);
    expect(rollupMonthlyGoodsCost([{ goodsAmount: null }, { goodsAmount: 20_000 }])).toBe(20_000);
    expect(rollupMonthlyGoodsCost([{ goodsAmount: null }])).toBeNull();
    expect(rollupMonthlyGoodsCost([])).toBeNull();
  });

  it("0 은 값이다 — 다른 캠페인 계산서에 합산된 0원 줄도 합에 남는다", () => {
    expect(rollupMonthlyGoodsCost([{ goodsAmount: 0 }])).toBe(0);
  });
});

describe("합계 검증", () => {
  it("월별 거래액 합과 캠페인 총액의 차이를 낸다", () => {
    const summary = summarizeMonthlySettlements(
      [
        line({ transactionAmount: 300_000, goodsAmount: 150_000 }),
        line({ yearMonth: "2026-10", transactionAmount: 100_000, paymentAmount: 60_000, ...ALL_CHECKED }),
      ],
      400_000,
    );
    expect(summary.transactionDiff).toBe(0);
    expect(summary.paymentTotal).toBe(210_000);
    expect(summary.completedLines).toBe(1);
    expect(summary.lineCount).toBe(2);
  });

  it("어긋나면 부호 있는 차이, 캠페인 총액이 없으면 비교하지 않는다", () => {
    expect(summarizeMonthlySettlements([line({ transactionAmount: 90_000 })], 100_000).transactionDiff).toBe(
      -10_000,
    );
    expect(summarizeMonthlySettlements([line({ transactionAmount: 90_000 })], null).transactionDiff).toBeNull();
  });
});

describe("주문일 기준 참고값", () => {
  it("일별 매출을 KST 날짜의 달로 나눠 더한다", () => {
    expect(
      attributeDailyStatsToMonths([
        { date: "2026-09-29", orders: 2, revenue: 20_000 },
        { date: "2026-09-30", orders: 1, revenue: 10_000 },
        { date: "2026-10-01", orders: 3, revenue: 30_000 },
      ]),
    ).toEqual({
      "2026-09": { orders: 3, revenue: 30_000 },
      "2026-10": { orders: 3, revenue: 30_000 },
    });
  });
});
