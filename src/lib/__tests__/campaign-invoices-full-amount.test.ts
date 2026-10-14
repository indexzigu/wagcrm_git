import { describe, expect, it } from "vitest";
import {
  AUTO_RECORD_REVIEW_LABEL,
  INVOICE_MONTH_HINT,
  INVOICE_MONTH_LABEL,
  INVOICE_MONTH_NOTE_HINT,
  INVOICE_MONTH_TONE,
  MINOR_DELTA_RATIO,
  deriveInvoiceMonths,
  findInvoiceCandidates,
  isFullAmountCovered,
  isInvoiceMonthDone,
  isPlausibleMonthlyWrittenMonth,
  judgeFullAmount,
  planAutoRecords,
  resolveLegacyInvoiceDate,
  summarizeInvoiceRows,
  type AutoRecordUnit,
  type CampaignInvoiceRow,
  type InvoiceMailSummary,
  type StatementMailSummary,
} from "../campaign-invoices";
import { buildTaxInvoiceObligationRows, resolveSupplierInvoiceUnitTotal } from "../tax-filing-board";
import type { CampaignRow } from "@/lib/crm-types";

// 월정산 계산서 「발행 내역 먼저」 판정(오너 확정 2026-10-14). 금액·사업자번호·이름은 가공이다(P0).
const OURS = "1111111111";
const BRAND = "2222222222";
const EXPECTED = 1_100_000;
/** 9/27~10/4 KST — 달을 넘는 캠페인 */
const CROSSING = { periodStart: new Date("2026-09-26T15:00:00Z"), periodEnd: new Date("2026-10-04T14:59:59Z") };
/** 9/10~9/20 KST — 한 달 안 캠페인 */
const SINGLE = { periodStart: new Date("2026-09-09T15:00:00Z"), periodEnd: new Date("2026-09-20T14:59:59Z") };

function row(overrides: Partial<CampaignInvoiceRow> = {}): CampaignInvoiceRow {
  return {
    id: "r1",
    campaignId: "c1",
    direction: "ISSUE",
    yearMonth: "2026-09",
    status: "RECORDED",
    writtenAt: "2026-09-30",
    approvalNo: "A-1",
    supplyAmount: 1_000_000,
    taxAmount: 100_000,
    totalAmount: EXPECTED,
    itemName: null,
    source: "MAIL",
    mailReceivedAt: null,
    note: null,
    ...overrides,
  };
}

function mail(overrides: Partial<InvoiceMailSummary> = {}): InvoiceMailSummary {
  return {
    issueId: "M-1",
    typeCode: "0101",
    writtenDate: "2026-09-30",
    invoicerBusinessNumber: OURS,
    invoiceeBusinessNumber: BRAND,
    supplyAmount: 1_000_000,
    taxAmount: 100_000,
    totalAmount: EXPECTED,
    itemName: "판매수수료",
    receivedAt: "2026-10-02T02:00:00.000Z",
    ...overrides,
  };
}

function candidates(mails: InvoiceMailSummary[]) {
  return findInvoiceCandidates({
    mails,
    direction: "ISSUE",
    ourBusinessNumber: OURS,
    counterpartBusinessNumber: BRAND,
    excludedIssueIds: new Set(),
  });
}

describe("isFullAmountCovered — 기록한 계산서 합계가 단위 전액과 맞는가", () => {
  it("정확히 같거나 99원 안이면 맞다 · 100원부터는 아니다", () => {
    expect(isFullAmountCovered([row()], EXPECTED)).toBe(true);
    expect(isFullAmountCovered([row({ totalAmount: EXPECTED - 99 })], EXPECTED)).toBe(true);
    expect(isFullAmountCovered([row({ totalAmount: EXPECTED + 100 })], EXPECTED)).toBe(false);
    expect(isFullAmountCovered([row({ totalAmount: EXPECTED - 100 })], EXPECTED)).toBe(false);
  });

  it("전액을 모르거나, 금액 모르는 기록이 있거나, 기록이 없으면 판단하지 않는다", () => {
    expect(isFullAmountCovered([row()], null)).toBe(false);
    expect(isFullAmountCovered([row()], undefined)).toBe(false);
    expect(isFullAmountCovered([row({ totalAmount: null })], EXPECTED)).toBe(false);
    expect(isFullAmountCovered([], EXPECTED)).toBe(false);
  });

  it("「없음」 행은 합계에 들지 않는다 · 그룹 멤버 여러 캠페인의 기록은 합친다", () => {
    const waived = row({ id: "w", status: "WAIVED", yearMonth: "2026-10", totalAmount: null, approvalNo: null });
    expect(isFullAmountCovered([row(), waived], EXPECTED)).toBe(true);
    const split = [
      row({ id: "a", campaignId: "g1", totalAmount: 600_000 }),
      row({ id: "b", campaignId: "g2", yearMonth: "2026-10", totalAmount: 500_000, approvalNo: "A-2" }),
    ];
    expect(isFullAmountCovered(split, EXPECTED)).toBe(true);
  });
});

describe("요약 · 달 줄 · 레거시 롤업 — 한 번에 끊은 단위는 끝이다", () => {
  it("9월 계산서 한 장이 전액이면 10월도 끝(COVERED) — done=total, 롤업은 그 작성일", () => {
    const rows = [row()];
    expect(summarizeInvoiceRows({ ...CROSSING, rows, expectedTotalAmount: EXPECTED })).toEqual({
      done: 2,
      total: 2,
      openMonths: [],
    });
    expect(resolveLegacyInvoiceDate({ ...CROSSING, rows, expectedTotalAmount: EXPECTED })).toBe("2026-09-30");
    const months = deriveInvoiceMonths({
      ...CROSSING,
      rows,
      ...candidates([]),
      scanSinceYmd: "2026-08-15",
      today: new Date("2026-10-20T00:00:00Z"),
      expectedTotalAmount: EXPECTED,
    });
    expect(months.map((m) => m.state)).toEqual(["RECORDED", "COVERED"]);
    expect(months.filter((m) => isInvoiceMonthDone(m.state))).toHaveLength(2);
  });

  it("전액을 모르면 종전 그대로 — 10월은 열려 있다", () => {
    expect(summarizeInvoiceRows({ ...CROSSING, rows: [row()], expectedTotalAmount: null }).openMonths).toEqual(["2026-10"]);
    expect(summarizeInvoiceRows({ ...CROSSING, rows: [row()] }).openMonths).toEqual(["2026-10"]);
  });

  it("금액이 모자라면(나눠 끊는 중) 10월은 열려 있다", () => {
    expect(
      summarizeInvoiceRows({ ...CROSSING, rows: [row({ totalAmount: 600_000 })], expectedTotalAmount: EXPECTED }).openMonths,
    ).toEqual(["2026-10"]);
  });

  it("새 상태의 낱말·풀이·색이 표에 있고 풀이에 em-dash 가 없다", () => {
    for (const state of ["COVERED", "MINOR_MISMATCH", "OVER_EXPECTED", "POSSIBLE_SPLIT"] as const) {
      expect(INVOICE_MONTH_LABEL[state]).toBeTruthy();
      expect(INVOICE_MONTH_HINT[state]).not.toContain("—");
    }
    expect(INVOICE_MONTH_LABEL.COVERED).toBe("한 번에");
    expect(INVOICE_MONTH_TONE.COVERED).toBe("none");
    expect(INVOICE_MONTH_HINT.MINOR_MISMATCH).toContain("정산 오류 가능성 · 원인 확인 필요");
    expect(INVOICE_MONTH_HINT.POSSIBLE_SPLIT).toContain("분할 발행 가능성 · 정산 메일 미확인");
    expect(INVOICE_MONTH_HINT.OVER_EXPECTED).toContain("기대액 초과 · 다른 건 포함 또는 기대액 오류 가능");
  });
});

describe("judgeFullAmount · deriveInvoiceMonths — 계산서만으로 본 판정", () => {
  const derive = (
    mails: InvoiceMailSummary[],
    overrides: Partial<Parameters<typeof deriveInvoiceMonths>[0]> = {},
  ) =>
    deriveInvoiceMonths({
      ...CROSSING,
      rows: [],
      ...candidates(mails),
      scanSinceYmd: "2026-08-15",
      today: new Date("2026-11-20T00:00:00Z"),
      expectedTotalAmount: EXPECTED,
      ...overrides,
    });
  const states = (months: ReturnType<typeof derive>) => months.map((m) => m.state);

  it("한 장이 전액과 맞으면 그 달은 확인대기(기록 전) — 판정은 MATCH", () => {
    expect(states(derive([mail()]))).toEqual(["PENDING", "NOT_FOUND"]);
  });

  it("허용오차를 넘고 5% 이내면 「오류 가능성」 — 5% 경계는 포함, 넘으면 「분할 가능성」", () => {
    const atBoundary = EXPECTED - EXPECTED * MINOR_DELTA_RATIO;
    expect(MINOR_DELTA_RATIO).toBe(0.05);
    expect(states(derive([mail({ totalAmount: EXPECTED - 1_000 })]))).toEqual(["MINOR_MISMATCH", "NOT_FOUND"]);
    expect(states(derive([mail({ totalAmount: atBoundary })]))).toEqual(["MINOR_MISMATCH", "NOT_FOUND"]);
    expect(states(derive([mail({ totalAmount: atBoundary - 1 })]))).toEqual(["POSSIBLE_SPLIT", "NOT_FOUND"]);
  });

  it("전액보다 비율 이상 많으면 「기대액 초과」(부호로 가른다) — 조금 많으면 「오류 가능성」", () => {
    expect(states(derive([mail({ totalAmount: EXPECTED * 1.5 })]))).toEqual(["OVER_EXPECTED", "NOT_FOUND"]);
    expect(states(derive([mail({ totalAmount: EXPECTED + 1_000 })]))).toEqual(["MINOR_MISMATCH", "NOT_FOUND"]);
  });

  it("한 달짜리 캠페인은 나눠 끊을 달이 없다 — 조금 어긋나도 크게 모자라도 「오류 가능성」, 자동 완료 아님", () => {
    const single = (total: number) =>
      deriveInvoiceMonths({
        ...SINGLE,
        rows: [],
        ...candidates([mail({ totalAmount: total })]),
        scanSinceYmd: "2026-08-15",
        today: new Date("2026-11-20T00:00:00Z"),
        expectedTotalAmount: EXPECTED,
      }).map((m) => m.state);
    expect(single(EXPECTED - 1_000)).toEqual(["MINOR_MISMATCH"]);
    expect(single(EXPECTED / 2)).toEqual(["MINOR_MISMATCH"]);
    expect(single(EXPECTED)).toEqual(["PENDING"]);
  });

  it("두 달 계산서의 합계가 전액이면 나눠 끊은 것이 계산서로 확인된다(MATCH, 각 달 확인대기)", () => {
    const split = [
      mail({ issueId: "M-9", totalAmount: 600_000 }),
      mail({ issueId: "M-10", writtenDate: "2026-10-31", totalAmount: 500_000 }),
    ];
    expect(states(derive(split))).toEqual(["PENDING", "PENDING"]);
    const verdict = judgeFullAmount({
      periodMonths: ["2026-09", "2026-10"],
      closedMonths: new Set(),
      expectedTotalAmount: EXPECTED,
      recordedTotalAmount: 0,
      candidatesByMonth: candidates(split).candidatesByMonth,
    });
    expect(verdict.kind).toBe("MATCH");
  });

  it("정산서가 그 달 금액을 말하면 정산서 경로 — 「분할 가능성」을 띄우지 않는다", () => {
    const expectationsByMonth = new Map([
      ["2026-09", [{ totalAmount: 600_000, writtenDate: "2026-09-30", dueDate: null, promotionLabel: null, receivedAt: "" }]],
    ]);
    expect(states(derive([mail({ totalAmount: 600_000 })], { expectationsByMonth }))).toEqual(["PENDING", "NOT_FOUND"]);
    expect(states(derive([mail({ totalAmount: 600_000 })]))).toEqual(["POSSIBLE_SPLIT", "NOT_FOUND"]);
  });

  it("전액이 수동 입력값에서 왔으면 어긋남 달에만 「CRM 금액 재확인」 풀이가 붙는다", () => {
    const minor = derive([mail({ totalAmount: EXPECTED - 1_000 })], { expectedFromManual: true });
    expect(minor[0].notes).toEqual(["EXPECTED_FROM_MANUAL"]);
    expect(INVOICE_MONTH_NOTE_HINT.EXPECTED_FROM_MANUAL).toBe("기대액이 수동 입력값에서 계산됨 · CRM 금액 재확인");
    expect(derive([mail({ totalAmount: EXPECTED - 1_000 })])[0].notes).toEqual([]);
    expect(derive([mail({ totalAmount: EXPECTED / 2 })], { expectedFromManual: true })[0].notes).toEqual([]);
    expect(derive([mail({ totalAmount: EXPECTED * 1.5 })], { expectedFromManual: true })[0].notes).toEqual([
      "EXPECTED_FROM_MANUAL",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 자동 기록 — 정산서 없는 전액 판정
// ---------------------------------------------------------------------------

function unit(overrides: Partial<AutoRecordUnit> = {}): AutoRecordUnit {
  return {
    unitKey: "c1",
    anchorCampaignId: "c1",
    direction: "ISSUE",
    counterpartBusinessNumber: BRAND,
    counterpartLabel: "브랜드A",
    openMonths: ["2026-09", "2026-10"],
    labels: ["가나다"],
    dismissedIssueIds: [],
    expectedTotalAmount: EXPECTED,
    expectedFromManual: false,
    recordedTotalAmount: 0,
    periodMonths: ["2026-09", "2026-10"],
    closedMonths: [],
    ...overrides,
  };
}

function statement(overrides: Partial<StatementMailSummary> = {}): StatementMailSummary {
  return {
    promotionLabel: "26년 9월 가나다 공구",
    counterpartyLabel: "브랜드A",
    subject: "[브랜드A] 가나다님 마감정산서",
    receivedAt: "2026-10-02T02:00:00.000Z",
    invoices: [{ direction: "ISSUE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 600_000, dueDate: null }],
    ...overrides,
  };
}

const plan = (overrides: Partial<Parameters<typeof planAutoRecords>[0]> = {}) =>
  planAutoRecords({
    units: [unit()],
    mails: [mail()],
    statements: [],
    ourBusinessNumber: OURS,
    recordedIssueIds: new Set(),
    ...overrides,
  });

describe("planAutoRecords — 정산서 없는 전액 판정", () => {
  it("전액과 맞는 계산서 한 장이면 그 작성월에 기록한다(근거 FULL_AMOUNT) — 그 단위의 「정산서 없음」은 지운다", () => {
    const { ops, skipped, needsReview } = plan();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ yearMonth: "2026-09", basis: "FULL_AMOUNT", expectedTotal: EXPECTED, delta: 0, expected: null });
    expect(skipped).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  it("전액을 모르면 종전 그대로(정산서 없음)", () => {
    const { ops, skipped } = plan({ units: [unit({ expectedTotalAmount: null })] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["NO_STATEMENT", "NO_STATEMENT"]);
  });

  it("정산서가 있으면 정산서 경로가 먼저다 — 전액 판정을 하지 않는다", () => {
    const { ops, skipped } = plan({ statements: [statement()] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["NO_AMOUNT_MATCH", "NO_STATEMENT"]);
    const viaStatement = plan({ statements: [statement()], mails: [mail({ totalAmount: 600_000 })] });
    expect(viaStatement.ops).toMatchObject([{ basis: "STATEMENT", expectedTotal: 600_000 }]);
  });

  it("두 달 계산서 합계가 전액이면 각 달에 기록 · 한 달에 두 장이면 고르지 않는다", () => {
    const split = plan({
      mails: [mail({ issueId: "M-9", totalAmount: 600_000 }), mail({ issueId: "M-10", writtenDate: "2026-10-31", totalAmount: 500_000 })],
    });
    expect(split.ops.map((op) => [op.yearMonth, op.basis])).toEqual([
      ["2026-09", "FULL_AMOUNT"],
      ["2026-10", "FULL_AMOUNT"],
    ]);
    const sameMonth = plan({ mails: [mail({ issueId: "M-9", totalAmount: 600_000 }), mail({ issueId: "M-10", totalAmount: 500_000 })] });
    expect(sameMonth.ops).toEqual([]);
    expect(sameMonth.skipped.map((s) => s.reason)).toEqual(["AMBIGUOUS_FULL_AMOUNT"]);
  });

  it("수정세금계산서가 따라와 있으면 기록하지 않는다", () => {
    const { ops, skipped } = plan({ mails: [mail(), mail({ issueId: "B-1", typeCode: "0201", totalAmount: -EXPECTED })] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["AMENDMENT_PENDING"]);
  });

  it("어긋남은 기록하지 않고 이유 코드로 오너에게 — 오류 가능성 · 분할 가능성 · 기대액 초과", () => {
    const minor = plan({ mails: [mail({ totalAmount: EXPECTED - 1_000 })] });
    expect(minor.ops).toEqual([]);
    expect(minor.skipped).toEqual([{ unitKey: "c1", yearMonth: "2026-09", reason: "MINOR_MISMATCH" }]);
    expect(minor.needsReview).toEqual([
      { unitKey: "c1", campaignId: "c1", yearMonth: "2026-09", reason: "MINOR_MISMATCH", notes: [] },
    ]);
    expect(plan({ mails: [mail({ totalAmount: 600_000 })] }).needsReview.map((r) => r.reason)).toEqual(["POSSIBLE_SPLIT"]);
    expect(plan({ mails: [mail({ totalAmount: EXPECTED * 2 })] }).needsReview.map((r) => r.reason)).toEqual(["OVER_EXPECTED"]);
    expect(AUTO_RECORD_REVIEW_LABEL.OVER_EXPECTED).toBe("기대액 초과 · 다른 건 포함 또는 기대액 오류 가능");
  });

  it("수동 입력에서 온 전액이면 오류 가능성·기대액 초과에만 EXPECTED_FROM_MANUAL 을 붙인다(판정은 같다)", () => {
    const manual = (total: number) =>
      plan({ units: [unit({ expectedFromManual: true })], mails: [mail({ totalAmount: total })] }).needsReview[0];
    expect(manual(EXPECTED - 1_000).notes).toEqual(["EXPECTED_FROM_MANUAL"]);
    expect(manual(EXPECTED * 2).notes).toEqual(["EXPECTED_FROM_MANUAL"]);
    expect(manual(600_000).notes).toEqual([]);
    expect(plan({ units: [unit({ expectedFromManual: true })] }).ops).toHaveLength(1);
  });

  it("H3 — 작성일은 [기간 첫 달, 마지막 달 + 1] 안이어야 자동 기록한다(+1 달은 허용, +2 달은 아님)", () => {
    expect(isPlausibleMonthlyWrittenMonth(["2026-09", "2026-10"], "2026-11")).toBe(true);
    expect(isPlausibleMonthlyWrittenMonth(["2026-09", "2026-10"], "2026-12")).toBe(false);
    expect(isPlausibleMonthlyWrittenMonth(["2026-09", "2026-10"], "2026-08")).toBe(false);
    expect(plan({ mails: [mail({ writtenDate: "2026-11-30" })] }).ops).toHaveLength(1);
    const late = plan({ mails: [mail({ writtenDate: "2026-12-31" })] });
    expect(late.ops).toEqual([]);
    expect(late.needsReview).toMatchObject([{ reason: "WRITTEN_DATE_IMPLAUSIBLE", yearMonth: "2026-12" }]);
  });

  it("H1 — 같은 상대의 다른 단위가 같은 전액이면 고르지 않지만, 품목명이 이 단위를 가리키면 고른다", () => {
    const other = unit({ unitKey: "c2", anchorCampaignId: "c2", labels: ["라마바"] });
    const twin = plan({ units: [unit(), other] });
    expect(twin.ops).toEqual([]);
    expect(twin.skipped.filter((s) => s.unitKey === "c1").map((s) => s.reason)).toEqual(["AMBIGUOUS_FULL_AMOUNT"]);
    const named = plan({ units: [unit(), other], mails: [mail({ itemName: "가나다 9월 공구 수수료" })] });
    expect(named.ops.map((op) => op.unitKey)).toEqual(["c1"]);
  });

  it("H1 — 금액이 맞아도 품목명이 다른 단위(셀러)를 가리키면 기록하지 않는다", () => {
    const other = unit({ unitKey: "c2", anchorCampaignId: "c2", labels: ["라마바"], expectedTotalAmount: 500_000 });
    const { ops, needsReview } = plan({ units: [unit(), other], mails: [mail({ itemName: "라마바 공구 수수료" })] });
    expect(ops).toEqual([]);
    // c2 는 같은 계산서를 자기 전액(50만)과 맞춰 「기대액 초과」로 따로 넘긴다.
    expect(needsReview.map((r) => [r.unitKey, r.reason])).toEqual([
      ["c1", "LINE_ITEM_CONTRADICTS"],
      ["c2", "OVER_EXPECTED"],
    ]);
  });

  it("이미 기록한 계산서가 있으면 나머지 금액으로 맞춘다(기록 + 후보 합계)", () => {
    const { ops } = plan({
      units: [unit({ recordedTotalAmount: 600_000, closedMonths: ["2026-09"], openMonths: ["2026-10"] })],
      mails: [mail({ issueId: "M-10", writtenDate: "2026-10-31", totalAmount: 500_000 })],
    });
    expect(ops).toMatchObject([{ yearMonth: "2026-10", basis: "FULL_AMOUNT" }]);
  });
});

describe("resolveSupplierInvoiceUnitTotal — 세무 보드와 같은 전액", () => {
  function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
    return {
      id: "c1",
      dealName: "딜A",
      campaignName: "딜A - 셀러1",
      partnerName: "브랜드A",
      partnerBusinessNumber: BRAND,
      partnerCeoName: "대표",
      sellerId: "s1",
      sellerName: "셀러1",
      endDate: "2026-10-04",
      salesChannel: "BRAND_MALL",
      sellerTaxType: "BUSINESS",
      actualSales: 5_000_000,
      sellerExpense: 1_000_000,
      settlementSales: 1_234_567,
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
      ...overrides,
    } as CampaignRow;
  }

  it("보드의 공급사 행 금액(공급가 + 세액)과 같다 — 단독·그룹", () => {
    const single = campaign();
    const boardRow = buildTaxInvoiceObligationRows([single]).rows.find((r) => r.sourceField === "supplierInvoiceIssuedAt")!;
    const total = resolveSupplierInvoiceUnitTotal({ members: [single], grouped: false });
    expect(total?.totalAmount).toBe(boardRow.amount.supplyAmount + boardRow.amount.taxAmount);

    const members = [campaign({ id: "g1", groupId: "G" }), campaign({ id: "g2", groupId: "G", settlementSales: 765_433 })];
    const groupRow = buildTaxInvoiceObligationRows(members).rows.find((r) => r.sourceField === "supplierInvoiceIssuedAt")!;
    const groupTotal = resolveSupplierInvoiceUnitTotal({ members, grouped: true });
    expect(groupTotal?.totalAmount).toBe(groupRow.amount.supplyAmount + groupRow.amount.taxAmount);
  });

  it("모르는 금액은 null — 결번 · 채널이 갈린 그룹 · 공급사가 갈린 그룹", () => {
    expect(resolveSupplierInvoiceUnitTotal({ members: [campaign({ settlementSales: null })], grouped: false })).toBeNull();
    expect(
      resolveSupplierInvoiceUnitTotal({ members: [campaign(), campaign({ salesChannel: "OWN_MALL" })], grouped: true }),
    ).toBeNull();
    expect(
      resolveSupplierInvoiceUnitTotal({ members: [campaign(), campaign({ partnerBusinessNumber: "9999999999" })], grouped: true }),
    ).toBeNull();
  });

  it("H7 — 금액을 만든 입력 중 수동 고정값이 있으면 표시한다", () => {
    expect(resolveSupplierInvoiceUnitTotal({ members: [campaign()], grouped: false })?.fromManualInput).toBe(false);
    expect(
      resolveSupplierInvoiceUnitTotal({ members: [campaign({ isManualSettlementSales: true })], grouped: false })?.fromManualInput,
    ).toBe(true);
    // 셀러 정산금 수동 고정은 브랜드몰 공급사 금액(영업수익 기준)에 쓰이지 않는다.
    expect(
      resolveSupplierInvoiceUnitTotal({ members: [campaign({ isManualSellerExpense: true })], grouped: false })?.fromManualInput,
    ).toBe(false);
    // 물품대금(우리몰 수취)은 수기 물품대금이 곧 수동 값이다.
    expect(
      resolveSupplierInvoiceUnitTotal({
        members: [campaign({ salesChannel: "OWN_MALL", settlementGoodsCost: 2_000_000 })],
        grouped: false,
      })?.fromManualInput,
    ).toBe(true);
  });
});
