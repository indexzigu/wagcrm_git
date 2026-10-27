import { describe, expect, it } from "vitest";
import {
  INVOICE_LOOKUP_DAYS_AFTER_END,
  INVOICE_LOOKUP_START_DAYS_AFTER_END,
  addDaysToYmd,
  invoiceLookupFirstYmd,
  hasOpenInvoiceLookupTarget,
  invoiceLookupLastYmd,
  invoiceLookupSinceDays,
  isInvoiceLookupTarget,
  MONTHLY_INVOICE_LOOKUP_STATUSES,
} from "./invoice-lookup-scope";

/** 일반 캠페인(월정산 아님) — 판매 시작일은 판정에 쓰이지 않는다. */
const general = (status: string, endYmd: string) => ({ status, startYmd: "2026-01-01", endYmd, monthlySettlement: false });
/** 월정산 거래처 캠페인. */
const monthly = (status: string, startYmd: string, endYmd: string) => ({ status, startYmd, endYmd, monthlySettlement: true });
/** 조회 창 계산용 — 일반 캠페인의 종료일만 준다. */
const ends = (...endYmds: string[]) => endYmds.map((endYmd) => ({ startYmd: "2026-01-01", endYmd, monthlySettlement: false }));

describe("계산서 자동 조회 대상 — 정산 단계 · 판매 종료 +10일 ~ +60일 (오너 확정 2026-10-21)", () => {
  it("기간 숫자는 오너가 정한 값이다", () => {
    expect(INVOICE_LOOKUP_DAYS_AFTER_END).toBe(60);
    expect(INVOICE_LOOKUP_START_DAYS_AFTER_END).toEqual({ auto: 10, manual: 1 });
  });

  it("달·해를 넘기는 날짜 산술", () => {
    expect(addDaysToYmd("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToYmd("2026-12-15", 60)).toBe("2027-02-13");
    expect(invoiceLookupLastYmd("2026-09-16")).toBe("2026-11-15");
    expect(invoiceLookupFirstYmd("2026-09-16", "auto")).toBe("2026-09-26");
    expect(invoiceLookupFirstYmd("2026-09-30", "manual")).toBe("2026-10-01");
  });

  it("정산대기·정산중이고 종료 +10일째부터 +60일째(양끝 포함)까지 대상이다", () => {
    expect(isInvoiceLookupTarget(general("SETTLEMENT_WAIT", "2026-09-16"), "2026-09-26")).toBe(true);
    expect(isInvoiceLookupTarget(general("SETTLEMENT_WAIT", "2026-09-16"), "2026-10-21")).toBe(true);
    expect(isInvoiceLookupTarget(general("SETTLEMENT_IN_PROGRESS", "2026-09-16"), "2026-11-15")).toBe(true);
  });

  it("종료 +9일째까지와 +61일째부터는 대상이 아니다", () => {
    expect(isInvoiceLookupTarget(general("SETTLEMENT_WAIT", "2026-09-16"), "2026-09-25")).toBe(false);
    expect(isInvoiceLookupTarget(general("SETTLEMENT_IN_PROGRESS", "2026-09-16"), "2026-11-16")).toBe(false);
  });

  it("정산 단계가 아니면(판매 중·판매마감·완료·드랍) 날짜와 무관하게 대상이 아니다", () => {
    for (const status of ["ACTIVE", "CLOSED", "COMPLETED", "DROPPED", "PROPOSAL"]) {
      expect(isInvoiceLookupTarget(general(status, "2026-10-01"), "2026-10-21")).toBe(false);
    }
  });
});

describe("메일 조회 창 — 가장 이른 판매 종료일 +10일(자동) · +1일(수동)부터 오늘까지", () => {
  it("시작일 당일을 포함한다", () => {
    expect(invoiceLookupSinceDays(ends("2026-10-11"), "2026-10-21", "auto")).toBe(1);
    expect(invoiceLookupSinceDays(ends("2026-10-20"), "2026-10-21", "manual")).toBe(1);
    expect(invoiceLookupSinceDays(ends("2026-10-10"), "2026-10-21", "manual")).toBe(11);
  });

  it("같은 종료일이면 수동이 자동보다 9일 넓다", () => {
    expect(invoiceLookupSinceDays(ends("2026-09-16"), "2026-10-21", "auto")).toBe(26);
    expect(invoiceLookupSinceDays(ends("2026-09-16"), "2026-10-21", "manual")).toBe(35);
  });

  it("여럿이면 가장 이른 종료일 기준이다", () => {
    expect(invoiceLookupSinceDays(ends("2026-09-30", "2026-09-16", "2026-10-05"), "2026-10-21", "auto")).toBe(26);
  });

  it("시작일이 아직 오지 않았으면 오늘 하루만, 종료일이 없으면 null", () => {
    expect(invoiceLookupSinceDays(ends("2026-10-20"), "2026-10-21", "auto")).toBe(1);
    expect(invoiceLookupSinceDays(ends(), "2026-10-21", "auto")).toBeNull();
  });
});

describe("월정산 거래처 캠페인 — 판매 시작일부터 · 판매 중이어도 대상 (오너 확정 2026-10-27, T-270)", () => {
  it("판매중·판매마감·정산대기·정산중이 대상 상태다", () => {
    expect([...MONTHLY_INVOICE_LOOKUP_STATUSES]).toEqual(["ACTIVE", "CLOSED", "SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS"]);
  });

  it("판매 중이면 판매 시작일 당일부터 대상이다", () => {
    expect(isInvoiceLookupTarget(monthly("ACTIVE", "2026-09-28", "2026-11-30"), "2026-09-28")).toBe(true);
    expect(isInvoiceLookupTarget(monthly("ACTIVE", "2026-09-28", "2026-11-30"), "2026-09-27")).toBe(false);
  });

  it("판매마감·정산 단계도 종료 +10일을 기다리지 않는다", () => {
    expect(isInvoiceLookupTarget(monthly("CLOSED", "2026-09-28", "2026-10-05"), "2026-10-08")).toBe(true);
    expect(isInvoiceLookupTarget(monthly("SETTLEMENT_WAIT", "2026-09-28", "2026-10-05"), "2026-10-08")).toBe(true);
  });

  it("끝은 일반 캠페인과 같이 종료 +60일째까지다", () => {
    expect(isInvoiceLookupTarget(monthly("SETTLEMENT_IN_PROGRESS", "2026-09-28", "2026-10-05"), "2026-12-04")).toBe(true);
    expect(isInvoiceLookupTarget(monthly("SETTLEMENT_IN_PROGRESS", "2026-09-28", "2026-10-05"), "2026-12-05")).toBe(false);
  });

  it("세팅대기·제안중·정산완료·드랍은 대상이 아니다", () => {
    for (const status of ["PREPARATION", "PROPOSAL", "COMPLETED", "DROPPED"]) {
      expect(isInvoiceLookupTarget(monthly(status, "2026-09-28", "2026-10-05"), "2026-10-08")).toBe(false);
    }
  });

  it("같은 판매 기간의 일반 캠페인은 여전히 정산 단계 · 종료 +10일부터다", () => {
    expect(isInvoiceLookupTarget(general("ACTIVE", "2026-11-30"), "2026-10-08")).toBe(false);
    expect(isInvoiceLookupTarget(general("SETTLEMENT_WAIT", "2026-10-05"), "2026-10-08")).toBe(false);
  });

  it("메일은 판매 시작일부터 읽는다 — 자동·「조회」 버튼 모두", () => {
    // 9/28 ~ 10/27 = 30일. 9월분 계산서 메일(10/8 도착)이 창 안에 든다.
    const win = [{ startYmd: "2026-09-28", endYmd: "2026-10-05", monthlySettlement: true }];
    expect(invoiceLookupSinceDays(win, "2026-10-27", "auto")).toBe(30);
    expect(invoiceLookupSinceDays(win, "2026-10-27", "manual")).toBe(30);
  });

  it("월정산과 일반이 섞이면 더 이른 시작일 기준이다", () => {
    const win = [
      { startYmd: "2026-10-01", endYmd: "2026-10-31", monthlySettlement: true },
      { startYmd: "2026-01-01", endYmd: "2026-09-16", monthlySettlement: false }, // 9/26 부터
    ];
    expect(invoiceLookupSinceDays(win, "2026-10-27", "auto")).toBe(32);
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
