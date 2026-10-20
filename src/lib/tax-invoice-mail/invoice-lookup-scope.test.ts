import { describe, expect, it } from "vitest";
import {
  INVOICE_LOOKUP_DAYS_AFTER_END,
  addDaysToYmd,
  hasOpenInvoiceLookupTarget,
  invoiceLookupLastYmd,
  invoiceLookupSinceDays,
  isInvoiceLookupTarget,
} from "./invoice-lookup-scope";

describe("계산서 자동 조회 대상 — 정산 단계 · 판매 종료 후 60일 (오너 확정 2026-10-21)", () => {
  it("60일은 오너가 정한 값이다", () => {
    expect(INVOICE_LOOKUP_DAYS_AFTER_END).toBe(60);
  });

  it("달·해를 넘기는 날짜 산술", () => {
    expect(addDaysToYmd("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToYmd("2026-12-15", 60)).toBe("2027-02-13");
    expect(invoiceLookupLastYmd("2026-09-16")).toBe("2026-11-15");
  });

  it("정산대기·정산중이고 종료 후 60일째(당일 포함)까지는 대상이다", () => {
    expect(isInvoiceLookupTarget({ status: "SETTLEMENT_WAIT", endYmd: "2026-09-16" }, "2026-10-21")).toBe(true);
    expect(isInvoiceLookupTarget({ status: "SETTLEMENT_IN_PROGRESS", endYmd: "2026-09-16" }, "2026-11-15")).toBe(true);
  });

  it("종료 후 61일째부터는 대상이 아니다", () => {
    expect(isInvoiceLookupTarget({ status: "SETTLEMENT_IN_PROGRESS", endYmd: "2026-09-16" }, "2026-11-16")).toBe(false);
  });

  it("정산 단계가 아니면(판매 중·판매마감·완료·드랍) 날짜와 무관하게 대상이 아니다", () => {
    for (const status of ["ACTIVE", "CLOSED", "COMPLETED", "DROPPED", "PROPOSAL"]) {
      expect(isInvoiceLookupTarget({ status, endYmd: "2026-10-15" }, "2026-10-21")).toBe(false);
    }
  });
});

describe("메일 조회 창 — 가장 이른 판매 시작일부터 오늘까지", () => {
  it("시작일 당일을 포함한다", () => {
    expect(invoiceLookupSinceDays(["2026-10-21"], "2026-10-21")).toBe(1);
    expect(invoiceLookupSinceDays(["2026-10-20"], "2026-10-21")).toBe(2);
  });

  it("여럿이면 가장 이른 시작일 기준이다", () => {
    expect(invoiceLookupSinceDays(["2026-09-10", "2026-08-25", "2026-09-30"], "2026-10-21")).toBe(58);
  });

  it("대상이 없으면 null — 메일함을 열지 않는다", () => {
    expect(invoiceLookupSinceDays([], "2026-10-21")).toBeNull();
  });
});

describe("메일함을 열지 — 대상 중 발행 확인이 남은 것이 있을 때만", () => {
  const targetsOnly = { isTargetCampaign: (id: string) => id === "t", isTargetUnit: (key: string) => key === "t" };
  const issuance = (campaignId: string, alreadyMarkedAt: string | null) => ({ campaignIds: [campaignId], alreadyMarkedAt });
  const unit = (unitKey: string, openMonths: string[], direction = "ISSUE") => ({ unitKey, direction, openMonths });

  it("대상의 발행 날짜 칸이 비었으면 연다", () => {
    expect(hasOpenInvoiceLookupTarget({ issuances: [issuance("t", null)], monthlyUnits: [], ...targetsOnly })).toBe(true);
  });

  it("대상의 발행이 다 확인됐고 빈 달도 없으면 열지 않는다", () => {
    expect(
      hasOpenInvoiceLookupTarget({ issuances: [issuance("t", "2026-10-01")], monthlyUnits: [unit("t", [])], ...targetsOnly }),
    ).toBe(false);
  });

  it("비대상의 빈 칸·빈 달은 메일함을 열 이유가 아니다", () => {
    expect(
      hasOpenInvoiceLookupTarget({ issuances: [issuance("x", null)], monthlyUnits: [unit("x", ["2026-09"])], ...targetsOnly }),
    ).toBe(false);
  });

  it("대상 월정산 단위에 빈 발행 달이 있으면 연다(수취 방향 단위는 세지 않는다)", () => {
    expect(hasOpenInvoiceLookupTarget({ issuances: [], monthlyUnits: [unit("t", ["2026-09"])], ...targetsOnly })).toBe(true);
    expect(
      hasOpenInvoiceLookupTarget({ issuances: [], monthlyUnits: [unit("t", ["2026-09"], "RECEIVE")], ...targetsOnly }),
    ).toBe(false);
  });
});
