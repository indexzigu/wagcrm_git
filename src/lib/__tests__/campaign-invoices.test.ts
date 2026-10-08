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
  type CampaignInvoiceRow,
  type InvoiceMailSummary,
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
