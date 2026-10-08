import { describe, expect, it } from "vitest";
import {
  INVOICE_MONTH_LABEL,
  buildInvoiceIncompleteMessage,
  deriveInvoiceMonths,
  findInvoiceCandidates,
  listYearMonths,
  resolveLegacyInvoiceDate,
  resolveSupplierInvoiceDirection,
  summarizeInvoiceRows,
  collectStatementExpectations,
  matchesExpectedAmount,
  planAutoRecords,
  statementMentionsUnit,
  type AutoRecordUnit,
  type CampaignInvoiceRow,
  type InvoiceMailSummary,
  type StatementMailSummary,
} from "../campaign-invoices";

// 캠페인 계산서 여러 장(T-240 후속) 판정 계약. 금액·사업자번호는 가공이다(P0).
const OURS = "1111111111";
const BRAND = "2222222222";
const OTHER = "3333333333";

function mail(overrides: Partial<InvoiceMailSummary> = {}): InvoiceMailSummary {
  return {
    issueId: "A-1",
    typeCode: "0101",
    writtenDate: "2026-09-30",
    invoicerBusinessNumber: OURS,
    invoiceeBusinessNumber: BRAND,
    supplyAmount: 67_500,
    taxAmount: 6_750,
    totalAmount: 74_250,
    itemName: "9월 판매수수료",
    receivedAt: "2026-10-06T02:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<CampaignInvoiceRow> = {}): CampaignInvoiceRow {
  return {
    id: "r1",
    campaignId: "c1",
    direction: "ISSUE",
    yearMonth: "2026-09",
    status: "RECORDED",
    writtenAt: "2026-09-30",
    approvalNo: "A-1",
    supplyAmount: 67_500,
    taxAmount: 6_750,
    totalAmount: 74_250,
    itemName: null,
    source: "MAIL",
    mailReceivedAt: null,
    note: null,
    ...overrides,
  };
}

// 9/28~10/4 KST 캠페인(두 달에 걸침)
const PERIOD = { periodStart: new Date("2026-09-27T15:00:00Z"), periodEnd: new Date("2026-10-04T14:59:59Z") };

describe("listYearMonths — 기간에 걸친 KST 달", () => {
  it("두 달에 걸치면 두 달, 해를 넘겨도 빠짐없이", () => {
    expect(listYearMonths(PERIOD.periodStart, PERIOD.periodEnd)).toEqual(["2026-09", "2026-10"]);
    expect(listYearMonths(new Date("2026-11-20T00:00:00Z"), new Date("2027-02-01T00:00:00Z"))).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("UTC 로는 9월 말이어도 KST 로 10월 1일이면 10월이다", () => {
    expect(listYearMonths(new Date("2026-09-30T15:30:00Z"), new Date("2026-10-02T00:00:00Z"))).toEqual(["2026-10"]);
  });
});

describe("resolveSupplierInvoiceDirection — 채널 의무표가 정본", () => {
  it("브랜드몰은 우리가 발행, 그 외는 우리가 수취", () => {
    expect(resolveSupplierInvoiceDirection("BRAND_MALL")).toBe("ISSUE");
    expect(resolveSupplierInvoiceDirection("OWN_MALL")).toBe("RECEIVE");
    expect(resolveSupplierInvoiceDirection("SELLER_MALL")).toBe("RECEIVE");
  });
});

describe("findInvoiceCandidates — 구조 키(방향·상대·작성일 달)만으로 고른다", () => {
  const base = { direction: "ISSUE" as const, ourBusinessNumber: OURS, counterpartBusinessNumber: BRAND, excludedIssueIds: new Set<string>() };

  it("방향과 상대가 맞는 일반 계산서를 작성일의 달로 묶는다", () => {
    const { candidatesByMonth } = findInvoiceCandidates({
      ...base,
      mails: [mail(), mail({ issueId: "A-2", writtenDate: "2026-10-31" })],
    });
    expect(candidatesByMonth.get("2026-09")?.map((m) => m.issueId)).toEqual(["A-1"]);
    expect(candidatesByMonth.get("2026-10")?.map((m) => m.issueId)).toEqual(["A-2"]);
  });

  it("같은 상대가 우리에게 보낸 계산서(반대 방향 — 광고비 등 무관 건)는 발행 칸 후보가 아니다", () => {
    const { candidatesByMonth } = findInvoiceCandidates({
      ...base,
      mails: [mail({ invoicerBusinessNumber: BRAND, invoiceeBusinessNumber: OURS })],
    });
    expect(candidatesByMonth.size).toBe(0);
  });

  it("다른 상대·사업자번호 미등록이면 아무것도 고르지 않는다", () => {
    expect(findInvoiceCandidates({ ...base, mails: [mail({ invoiceeBusinessNumber: OTHER })] }).candidatesByMonth.size).toBe(0);
    expect(findInvoiceCandidates({ ...base, counterpartBusinessNumber: null, mails: [mail()] }).candidatesByMonth.size).toBe(0);
  });

  it("이미 기록·제외된 승인번호와 같은 계산서의 사본은 빠진다", () => {
    const { candidatesByMonth } = findInvoiceCandidates({
      ...base,
      excludedIssueIds: new Set(["A-1"]),
      mails: [mail(), mail({ issueId: "A-2" }), mail({ issueId: "A-2" })],
    });
    expect(candidatesByMonth.get("2026-09")?.map((m) => m.issueId)).toEqual(["A-2"]);
  });

  it("수정세금계산서(0201)는 후보가 아니라 수정 목록으로, 모르는 종류 코드는 버린다", () => {
    const { candidatesByMonth, amendmentsByMonth } = findInvoiceCandidates({
      ...base,
      mails: [mail({ issueId: "M-1", typeCode: "0201" }), mail({ issueId: "X-1", typeCode: "0301" })],
    });
    expect(candidatesByMonth.size).toBe(0);
    expect(amendmentsByMonth.get("2026-09")?.map((m) => m.issueId)).toEqual(["M-1"]);
  });

  it("수취 방향은 상대가 공급자, 우리가 공급받는자다", () => {
    const { candidatesByMonth } = findInvoiceCandidates({
      ...base,
      direction: "RECEIVE",
      mails: [mail({ invoicerBusinessNumber: BRAND, invoiceeBusinessNumber: OURS })],
    });
    expect(candidatesByMonth.get("2026-09")).toHaveLength(1);
  });
});

describe("deriveInvoiceMonths — 줄은 기간의 달마다 있고 내용만 바뀐다", () => {
  const empty = new Map<string, InvoiceMailSummary[]>();
  const derive = (overrides: Partial<Parameters<typeof deriveInvoiceMonths>[0]>) =>
    deriveInvoiceMonths({
      ...PERIOD,
      rows: [],
      candidatesByMonth: empty,
      amendmentsByMonth: empty,
      scanSinceYmd: "2026-08-15",
      today: new Date("2026-11-20T00:00:00Z"),
      ...overrides,
    });

  it("기록 · 후보 · 메일 없음이 각자 상태가 된다", () => {
    const months = derive({
      rows: [row()],
      candidatesByMonth: new Map([["2026-10", [mail({ issueId: "B-1", writtenDate: "2026-10-31" })]]]),
    });
    expect(months.map((m) => [m.yearMonth, m.state])).toEqual([
      ["2026-09", "RECORDED"],
      ["2026-10", "PENDING"],
    ]);
    expect(derive({}).map((m) => m.state)).toEqual(["NOT_FOUND", "NOT_FOUND"]);
  });

  it("그 달이 아직 안 끝났으면 「—」(NOT_DUE) — 지난달은 그대로 판정한다", () => {
    const months = derive({ today: new Date("2026-10-20T00:00:00Z") });
    expect(months.map((m) => m.state)).toEqual(["NOT_FOUND", "NOT_DUE"]);
  });

  it("메일함을 못 읽었거나 그 달 발급 메일이 조회 시작 전이면 조회불가", () => {
    expect(derive({ scanSinceYmd: null }).map((m) => m.state)).toEqual(["OUT_OF_SCAN", "OUT_OF_SCAN"]);
    // 9월분 발급 메일은 10/10 까지 온다 — 조회가 10/15 부터면 9월분만 판단 불가.
    expect(derive({ scanSinceYmd: "2026-10-15" }).map((m) => m.state)).toEqual(["OUT_OF_SCAN", "NOT_FOUND"]);
  });

  it("「없음」 표시한 달은 줄을 지우지 않고 WAIVED 로 남는다", () => {
    const months = derive({ rows: [row({ id: "w", yearMonth: "2026-10", status: "WAIVED", approvalNo: null, writtenAt: null })] });
    expect(months).toHaveLength(2);
    expect(months[1].state).toBe("WAIVED");
    expect(INVOICE_MONTH_LABEL.WAIVED).toBe("없음");
  });

  it("기록한 달에 처리 안 된 수정세금계산서가 따라오면 AMENDED, 처리하면 RECORDED 로 돌아온다", () => {
    const amendment = mail({ issueId: "M-1", typeCode: "0201" });
    const amended = derive({ rows: [row()], amendmentsByMonth: new Map([["2026-09", [amendment]]]) });
    expect(amended[0].state).toBe("AMENDED");
    const handled = derive({
      rows: [row(), row({ id: "d", status: "DISMISSED", approvalNo: "M-1" })],
      amendmentsByMonth: new Map([["2026-09", [amendment]]]),
    });
    expect(handled[0].state).toBe("RECORDED");
  });

  it("기간 밖 달에 기록한 계산서(이월분)도 줄로 보인다 — 행은 사실이다", () => {
    const months = derive({ rows: [row({ id: "late", yearMonth: "2026-11", writtenAt: "2026-11-30", approvalNo: "L-1" })] });
    expect(months.map((m) => m.yearMonth)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("「이 메일이 아님」(DISMISSED) 행은 달을 만들지도, 완료로 세지도 않는다", () => {
    const months = derive({ rows: [row({ status: "DISMISSED", yearMonth: "2026-12" })] });
    expect(months.map((m) => m.yearMonth)).toEqual(["2026-09", "2026-10"]);
    expect(months.every((m) => m.recorded.length === 0)).toBe(true);
  });
});

describe("완료 판정 · 레거시 날짜 롤업 — 저장된 행만으로", () => {
  it("모든 달이 기록 또는 「없음」이어야 끝이다", () => {
    expect(summarizeInvoiceRows({ ...PERIOD, rows: [row()] })).toEqual({ done: 1, total: 2, openMonths: ["2026-10"] });
    expect(
      summarizeInvoiceRows({
        ...PERIOD,
        rows: [row(), row({ id: "w", yearMonth: "2026-10", status: "WAIVED", approvalNo: null, writtenAt: null })],
      }).openMonths,
    ).toEqual([]);
  });

  it("레거시 날짜는 다 끝났을 때만, 가장 늦은 작성일로", () => {
    expect(resolveLegacyInvoiceDate({ ...PERIOD, rows: [row()] })).toBeNull();
    expect(
      resolveLegacyInvoiceDate({
        ...PERIOD,
        rows: [row(), row({ id: "r2", yearMonth: "2026-10", writtenAt: "2026-10-31", approvalNo: "A-2" })],
      }),
    ).toBe("2026-10-31");
  });

  it("전부 「없음」이면 기록할 날짜가 없다(완료는 통과)", () => {
    const waived = [
      row({ id: "w1", status: "WAIVED", approvalNo: null, writtenAt: null }),
      row({ id: "w2", yearMonth: "2026-10", status: "WAIVED", approvalNo: null, writtenAt: null }),
    ];
    expect(resolveLegacyInvoiceDate({ ...PERIOD, rows: waived })).toBeNull();
    expect(summarizeInvoiceRows({ ...PERIOD, rows: waived }).openMonths).toEqual([]);
  });

  it("막힌 달을 문구에 담는다", () => {
    expect(buildInvoiceIncompleteMessage(["2026-10", "2026-11"])).toContain("10월·11월분");
  });
});

// ---------------------------------------------------------------------------
// 정산서 대조 · 자동 기록 판정 (T-242)
// ---------------------------------------------------------------------------

function statement(overrides: Partial<StatementMailSummary> = {}): StatementMailSummary {
  return {
    promotionLabel: "26년 9월 가나다 공구",
    counterpartyLabel: "브랜드A",
    subject: "[브랜드A] 26년 9월 가나다님 - 마감정산서 검토 요청",
    receivedAt: "2026-10-02T02:00:00.000Z",
    invoices: [
      { direction: "RECEIVE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 165_000, dueDate: "2026-10-20" },
      { direction: "ISSUE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 74_250, dueDate: "2026-10-20" },
    ],
    ...overrides,
  };
}

function unit(overrides: Partial<AutoRecordUnit> = {}): AutoRecordUnit {
  return {
    unitKey: "c1",
    anchorCampaignId: "c1",
    direction: "ISSUE",
    counterpartBusinessNumber: BRAND,
    counterpartLabel: "브랜드A",
    openMonths: ["2026-09"],
    labels: ["가나다"],
    dismissedIssueIds: [],
    ...overrides,
  };
}

/** 같은 상대·같은 달에 우리가 발행한 계산서 여러 장 — 프로모션마다 1장이 정상이다. */
const SEPTEMBER_MAILS = [
  mail({ issueId: "A-1", totalAmount: 50_000 }),
  mail({ issueId: "A-2", totalAmount: 74_250 }),
  mail({ issueId: "A-3", totalAmount: 120_000 }),
];

const plan = (overrides: Partial<Parameters<typeof planAutoRecords>[0]> = {}) =>
  planAutoRecords({
    units: [unit()],
    mails: SEPTEMBER_MAILS,
    statements: [statement()],
    ourBusinessNumber: OURS,
    recordedIssueIds: new Set(),
    ...overrides,
  });

describe("정산서 대조", () => {
  it("프로모션명·제목에 셀러 이름이 있으면 그 단위 정산서다 — 한 글자 이름은 쓰지 않는다", () => {
    expect(statementMentionsUnit(statement(), ["가나다"])).toBe(true);
    expect(statementMentionsUnit(statement(), ["라마바"])).toBe(false);
    expect(statementMentionsUnit(statement(), ["가"])).toBe(false);
  });

  it("방향이 맞는 예상만 달별로 모으고, 재발송된 같은 정산서는 한 번만 센다", () => {
    const byMonth = collectStatementExpectations({
      statements: [statement(), statement({ receivedAt: "2026-10-03T00:00:00.000Z" })],
      direction: "ISSUE",
      labels: ["가나다"],
      counterpartLabel: "브랜드A",
    });
    expect(byMonth.get("2026-09")?.map((e) => e.totalAmount)).toEqual([74_250]);
  });

  it("같은 셀러라도 다른 브랜드가 보낸 정산서는 이 거래처 것이 아니다 — 브랜드를 못 읽어도 뺀다", () => {
    const collect = (counterpartyLabel: string | null) =>
      collectStatementExpectations({
        statements: [statement({ counterpartyLabel })],
        direction: "ISSUE",
        labels: ["가나다"],
        counterpartLabel: "브랜드A",
      });
    expect(collect("브랜드B").size).toBe(0);
    expect(collect(null).size).toBe(0);
    // 표기 차이(「주식회사」 등)는 같은 브랜드로 본다.
    expect(collect("주식회사 브랜드A").get("2026-09")).toHaveLength(1);
  });

  it("영문 이름은 세 글자부터 대조한다 — 두 글자 핸들은 우연히 겹친다", () => {
    const latin = statement({ subject: "[브랜드A] Jinro 마감정산서", promotionLabel: null });
    expect(statementMentionsUnit(latin, ["jin"])).toBe(true);
    expect(statementMentionsUnit(latin, ["ji"])).toBe(false);
  });

  it("다른 단위 이름도 들어 있는 정산서는 어느 쪽 것인지 몰라 뺀다", () => {
    const shared = statement({ subject: "가나다·라마바 합동 정산서" });
    const byMonth = collectStatementExpectations({
      statements: [shared],
      direction: "ISSUE",
      labels: ["가나다"],
      counterpartLabel: "브랜드A",
      otherUnitsLabels: [["라마바"]],
    });
    expect(byMonth.size).toBe(0);
  });

  it("금액 허용오차는 99원 — 100원부터는 다르다", () => {
    const expected = [{ totalAmount: 74_250, writtenDate: "2026-09-30", dueDate: null, promotionLabel: null, receivedAt: "" }];
    expect(matchesExpectedAmount(74_349, expected)).toBe(true);
    expect(matchesExpectedAmount(74_350, expected)).toBe(false);
    expect(matchesExpectedAmount(null, expected)).toBe(false);
  });
});

describe("planAutoRecords — 확인 없이 기록해도 되는가", () => {
  it("단일 칸 + 정산서 1건 + 금액이 맞는 계산서 1장이면 그 장만 고른다(같은 달 다른 장은 무시)", () => {
    const { ops, skipped } = plan();
    expect(skipped).toEqual([]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ campaignId: "c1", yearMonth: "2026-09", delta: 0 });
    expect(ops[0].mail.issueId).toBe("A-2");
  });

  it("99원 차이는 흡수하고 차이를 싣는다 · 100원이면 고르지 않는다", () => {
    const within = plan({ mails: [mail({ issueId: "A-2", totalAmount: 74_250 + 99 })] });
    expect(within.ops[0]?.delta).toBe(99);
    const outside = plan({ mails: [mail({ issueId: "A-2", totalAmount: 74_250 + 100 })] });
    expect(outside.ops).toEqual([]);
    expect(outside.skipped).toEqual([{ unitKey: "c1", yearMonth: "2026-09", reason: "NO_AMOUNT_MATCH" }]);
  });

  it("같은 상대·같은 달에 비어 있는 칸이 둘이면 고르지 않는다(단일 칸 아님)", () => {
    const { ops, skipped } = plan({ units: [unit(), unit({ unitKey: "c2", anchorCampaignId: "c2", labels: ["라마바"] })] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["MULTIPLE_OPEN_SLOTS", "MULTIPLE_OPEN_SLOTS"]);
  });

  it("정산서가 없거나, 금액이 맞는 장이 둘이면 고르지 않는다", () => {
    expect(plan({ statements: [] }).skipped.map((s) => s.reason)).toEqual(["NO_STATEMENT"]);
    const twins = plan({ mails: [mail({ issueId: "A-2" }), mail({ issueId: "A-9" })] });
    expect(twins.ops).toEqual([]);
    expect(twins.skipped.map((s) => s.reason)).toEqual(["AMBIGUOUS_AMOUNT"]);
  });

  it("정산서가 같은 달에 다른 금액 둘을 말하면 고르지 않는다", () => {
    const two = statement({
      invoices: [
        { direction: "ISSUE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 74_250, dueDate: null },
        { direction: "ISSUE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 10_000, dueDate: null },
      ],
    });
    expect(plan({ statements: [two] }).skipped.map((s) => s.reason)).toEqual(["MULTIPLE_STATEMENTS"]);
  });

  it("그 달에 수정세금계산서가 따라와 있으면 고르지 않는다", () => {
    const { ops, skipped } = plan({ mails: [...SEPTEMBER_MAILS, mail({ issueId: "B-1", typeCode: "0201", totalAmount: -74_250 })] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["AMENDMENT_PENDING"]);
  });

  it("이미 어디든 기록됐거나 이 단위에서 「이 메일이 아님」으로 뺀 계산서는 고르지 않는다", () => {
    expect(plan({ recordedIssueIds: new Set(["A-2"]) }).ops).toEqual([]);
    expect(plan({ units: [unit({ dismissedIssueIds: ["A-2"] })] }).ops).toEqual([]);
  });

  it("수취(RECEIVE) 단위는 판정 대상이 아니다 — 언제나 오너 1클릭", () => {
    const { ops, skipped } = plan({ units: [unit({ direction: "RECEIVE" })] });
    expect(ops).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("상대 사업자번호가 다른 계산서는 같은 금액이어도 고르지 않는다", () => {
    const { ops } = plan({ mails: [mail({ issueId: "A-2", invoiceeBusinessNumber: OTHER })] });
    expect(ops).toEqual([]);
  });
});

describe("planAutoRecords — 다른 브랜드 정산서 (코드 리뷰 2026-10-09)", () => {
  it("같은 셀러·같은 달 다른 브랜드 정산서의 금액으로는 고르지 않는다", () => {
    const otherBrand = statement({ counterpartyLabel: "브랜드B" });
    const { ops, skipped } = plan({ statements: [otherBrand] });
    expect(ops).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["NO_STATEMENT"]);
  });
});
