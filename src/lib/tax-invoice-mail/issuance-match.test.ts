import { describe, it, expect } from "vitest";
import type { ParsedEtaxInvoice } from "./etax-xml";
import type { ExpectedIssuance } from "./expected-issuances";
import { matchIssuedInvoices, type ScannedIssuedInvoice } from "./issuance-match";
import { SUB_HUNDRED_TRUNCATION_TOLERANCE_WON } from "./receipt-match";

/**
 * 발행 대조 판정의 계약.
 *
 * ⚠️ **음성 대조군이 이 스위트의 본체다.** 이 트랙에는 "판정 조건·문구가 테스트에 안 잡혀
 * 있어 바꿔도 전 스위트가 통과한" 실사고(#297)가 있다. 아래 `CONFIRMED 가 되면 안 되는`
 * 케이스들은 하나하나가 프로덕션 데이터를 잘못 찍는 경로다 — 지우거나 완화하지 말 것.
 */

const OURS = "1234567890";
const THEIRS = "2223344444";

function invoice(over: Partial<ParsedEtaxInvoice> = {}): ParsedEtaxInvoice {
  return {
    issueId: "202607010000000000000001",
    typeCode: "0101",
    purposeCode: "02",
    writtenDate: "2026-08-01",
    invoicerBusinessNumber: OURS,
    invoicerName: "우리",
    invoiceeBusinessNumber: THEIRS,
    invoiceeName: "상대",
    amounts: { supplyAmount: 300_000, taxAmount: 30_000, totalAmount: 330_000 },
    lineItems: [],
    declaredEncoding: "UTF-8",
    ...over,
  };
}

function scanned(parsed: ParsedEtaxInvoice, mailUid = 1): ScannedIssuedInvoice {
  return { mailUid, parsed };
}

function expectation(over: Partial<ExpectedIssuance> = {}): ExpectedIssuance {
  return {
    key: "c1:ISSUE:supplierInvoiceIssuedAt",
    campaignIds: ["c1"],
    campaignId: "c1",
    campaignLabel: "알파브랜드 1회차",
    channel: "BRAND_MALL",
    counterpartBusinessNumber: THEIRS,
    counterpartLabel: "거래처",
    counterpart: "SUPPLIER",
    expectedTotalAmount: 330_000,
    amountBasis: "SETTLEMENT_SALES",
    amountBlockingReasons: [],
    trackingField: "supplierInvoiceIssuedAt",
    alreadyMarkedAt: null,
    writeTarget: { kind: "campaign", campaignId: "c1" },
    validWrittenDateFrom: "2026-07-01",
    validWrittenDateTo: "2026-10-01",
    ...over,
  };
}

function run(invoices: ScannedIssuedInvoice[], expected: ExpectedIssuance[]) {
  return matchIssuedInvoices({ invoices, expected, ourBusinessNumber: OURS });
}

describe("matchIssuedInvoices — 확정되는 경로", () => {
  it("상대·금액·날짜가 맞으면 CONFIRMED 이고 작성일자를 관측값으로 낸다", () => {
    const { verdicts } = run([scanned(invoice())], [expectation()]);
    expect(verdicts[0].status).toBe("CONFIRMED");
    expect(verdicts[0].observed.writtenDate).toBe("2026-08-01");
    expect(verdicts[0].assigned[0].basis).toBe("SOLE_COUNTERPART");
  });

  it("한 건이 두 장으로 쪼개져도 합산해 확정한다(N:1) — 1:1 로 만들면 놓치는 실측 패턴", () => {
    const { verdicts } = run(
      [
        scanned(invoice({ issueId: "A", amounts: { supplyAmount: 200_000, taxAmount: 20_000, totalAmount: 220_000 } }), 1),
        scanned(invoice({ issueId: "B", writtenDate: "2026-08-03", amounts: { supplyAmount: 100_000, taxAmount: 10_000, totalAmount: 110_000 } }), 2),
      ],
      [expectation()],
    );
    expect(verdicts[0].status).toBe("CONFIRMED");
    expect(verdicts[0].assigned).toHaveLength(2);
    expect(verdicts[0].observed.totalAmount).toBe(330_000);
    // 여러 장이면 가장 늦은 작성일자를 찍는다 — 의무가 전부 이행된 시점이 그때다.
    expect(verdicts[0].observed.writtenDate).toBe("2026-08-03");
  });

  it("같은 상대에 기대 건이 둘이면 품목명이 어느 쪽인지 가른다", () => {
    const alpha = expectation({ key: "c1:ISSUE:supplierInvoiceIssuedAt", campaignId: "c1", campaignLabel: "알파브랜드 1회차" });
    const beta = expectation({
      key: "c2:ISSUE:supplierInvoiceIssuedAt",
      campaignId: "c2",
      campaignLabel: "베타브랜드 2회차",
      writeTarget: { kind: "campaign", campaignId: "c2" },
    });
    const { verdicts } = run(
      [scanned(invoice({ lineItems: [{ sequence: 1, name: "베타브랜드 2회차 광고대행", quantity: 1, unitPrice: null, supplyAmount: 300_000, taxAmount: 30_000 }] }))],
      [alpha, beta],
    );
    expect(verdicts.find((v) => v.key === beta.key)?.status).toBe("CONFIRMED");
    expect(verdicts.find((v) => v.key === alpha.key)?.status).toBe("UNSEEN");
    expect(verdicts.find((v) => v.key === beta.key)?.assigned[0].basis).toBe("LINE_ITEM");
  });
});

describe("matchIssuedInvoices — 확정되면 안 되는 경로 (음성 대조군)", () => {
  it("금액이 1원이라도 다르면 확정하지 않는다 (허용오차 기본 0)", () => {
    const { verdicts } = run(
      [scanned(invoice({ amounts: { supplyAmount: 300_000, taxAmount: 30_001, totalAmount: 330_001 } }))],
      [expectation()],
    );
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
  });

  it("통과 광고비처럼 계산서에만 실린 금액은 확정이 아니라 확인필요로 남는다", () => {
    const { verdicts } = run(
      [scanned(invoice({ amounts: { supplyAmount: 500_000, taxAmount: 50_000, totalAmount: 550_000 } }))],
      [expectation()],
    );
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].observed.amountDelta).toBe(220_000);
  });

  it("확인되지 않은 계산서 종류 코드(수정계산서 등)는 확정하지 않는다", () => {
    const { verdicts } = run([scanned(invoice({ typeCode: "0102" }))], [expectation()]);
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("UNVERIFIED_DOCUMENT_TYPE");
  });

  it("작성일자가 타당 창 밖이면 확정하지 않는다", () => {
    const { verdicts } = run([scanned(invoice({ writtenDate: "2026-12-25" }))], [expectation()]);
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("WRITTEN_DATE_OUT_OF_RANGE");
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
  });

  it("작성일자를 못 읽으면 확정하지 않는다(찍을 값이 없다)", () => {
    const { verdicts } = run([scanned(invoice({ writtenDate: null }))], [expectation()]);
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("WRITTEN_DATE_MISSING");
  });

  it("같은 승인번호가 두 번 관측되면 **두 건 모두** 확정하지 않는다", () => {
    const { verdicts } = run(
      [scanned(invoice({ issueId: "DUP" }), 1), scanned(invoice({ issueId: "DUP" }), 2)],
      [expectation({ expectedTotalAmount: 660_000 })],
    );
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("DUPLICATE_ISSUE");
  });

  it("그룹이 캠페인별로 후퇴한 건(writeTarget=null)은 금액이 맞아도 확정하지 않는다", () => {
    const { verdicts } = run([scanned(invoice())], [expectation({ writeTarget: null })]);
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("GROUP_FELL_BACK");
  });

  it("이미 발행 완료로 기록된 건은 다시 확정하지 않는다", () => {
    const { verdicts } = run(
      [scanned(invoice())],
      [expectation({ alreadyMarkedAt: "2026-08-01T00:00:00.000Z" })],
    );
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("ALREADY_MARKED");
  });

  it("기대 금액이 모름이면 확정하지 않는다(추측한 숫자로 대사하게 두지 않는다)", () => {
    const { verdicts } = run(
      [scanned(invoice())],
      [expectation({ expectedTotalAmount: null, amountBlockingReasons: ["영업수익(settlementSales)이 0 이하"] })],
    );
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("EXPECTED_AMOUNT_UNKNOWN");
  });

  it("UTF-8 이 아닌 선언이면 품목명을 못 믿으므로 확정하지 않는다", () => {
    const { verdicts } = run([scanned(invoice({ declaredEncoding: "EUC-KR" }))], [expectation()]);
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("ENCODING_UNTRUSTED");
  });

  it("공급자가 우리가 아니면 애초에 배정하지 않는다(수취 건을 발행으로 찍지 않는다)", () => {
    const { verdicts, unassigned } = run(
      [scanned(invoice({ invoicerBusinessNumber: THEIRS, invoiceeBusinessNumber: OURS }))],
      [expectation()],
    );
    expect(verdicts[0].status).toBe("UNSEEN");
    expect(unassigned[0].code).toBe("NOT_ISSUED_BY_US");
  });

  it("품목명으로도 동점이면 조용히 하나를 고르지 않고 AMBIGUOUS_MATCH 로 남긴다", () => {
    const a = expectation({ key: "c1:ISSUE:supplierInvoiceIssuedAt", campaignLabel: "감마브랜드 1회차" });
    const b = expectation({
      key: "c2:ISSUE:supplierInvoiceIssuedAt",
      campaignId: "c2",
      campaignLabel: "감마브랜드 1회차",
      writeTarget: { kind: "campaign", campaignId: "c2" },
    });
    const { verdicts, unassigned } = run(
      [scanned(invoice({ lineItems: [{ sequence: 1, name: "감마브랜드 1회차", quantity: 1, unitPrice: null, supplyAmount: 300_000, taxAmount: 30_000 }] }))],
      [a, b],
    );
    expect(unassigned[0].code).toBe("AMBIGUOUS_MATCH");
    expect(verdicts.every((v) => v.status === "UNSEEN")).toBe(true);
  });

  it("수정세금계산서(0201)로는 발행일을 찍지 않는다 — 취소분은 총액 부호가 반전된다", () => {
    // 타 세션 실물 확인(2026-08-06): 발행 방향에도 0201 이 실재한다. 이 코드가
    // 화이트리스트(`VERIFIED_TYPE_CODES = ["0101"]`)라 **새 코드는 기본이 거부**다 —
    // 블랙리스트로 바꾸면 아직 모르는 코드가 원본처럼 통과한다. 바꾸지 말 것.
    const { verdicts } = run([scanned(invoice({ typeCode: "0201" }))], [expectation()]);
    expect(verdicts[0].status).toBe("NEEDS_REVIEW");
    // 사유는 `CORRECTIVE_DOCUMENT` 로 정밀화됐지만(#303 의 `CORRECTIVE_TYPE_CODES`),
    // **확정을 막는다는 사실 자체는 화이트리스트가 보장한다** — 사유 이름이 바뀌어도
    // 이 위 줄(확정 안 됨)이 안전 주장의 본체다.
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("CORRECTIVE_DOCUMENT");
  });

  it("상대 사업자번호가 CRM 에 없으면 「미발행」이 아니라 **대조 불가**로 가른다", () => {
    const { verdicts } = run([], [expectation({ counterpartBusinessNumber: null })]);
    expect(verdicts[0].status).toBe("UNMATCHABLE");
  });

  it("한 장이라도 합계를 못 읽으면 읽힌 것만 더하지 않는다", () => {
    const { verdicts } = run(
      [
        scanned(invoice({ issueId: "A" }), 1),
        scanned(invoice({ issueId: "B", amounts: { supplyAmount: null, taxAmount: null, totalAmount: null } }), 2),
      ],
      [expectation()],
    );
    expect(verdicts[0].observed.totalAmount).toBeNull();
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("INVOICE_AMOUNT_MISSING");
  });
});

describe("matchIssuedInvoices — 「안 봤다」를 「안 왔다」로 말하지 않는다", () => {
  // 기대 건은 캠페인 창(270일)에서, 계산서는 메일 창(90일)에서 나온다. 그 차집합을
  // UNSEEN 으로 세면 조회하지 않은 구간을 미발행으로 단정하게 된다(#297 과 같은 부류).
  const old = expectation({ validWrittenDateFrom: "2026-01-01", validWrittenDateTo: "2026-03-01" });

  it("타당 구간이 통째로 조회 창보다 이르면 OUT_OF_SCAN_RANGE 다", () => {
    const { verdicts } = matchIssuedInvoices({
      invoices: [],
      expected: [old],
      ourBusinessNumber: OURS,
      scanWindowFromDate: "2026-05-01",
    });
    expect(verdicts[0].status).toBe("OUT_OF_SCAN_RANGE");
  });

  it("구간이 조회 창에 걸쳐 있으면 UNSEEN 이다(창 안이므로 실제로 못 본 것)", () => {
    const { verdicts } = matchIssuedInvoices({
      invoices: [],
      expected: [old],
      ourBusinessNumber: OURS,
      scanWindowFromDate: "2026-02-01",
    });
    expect(verdicts[0].status).toBe("UNSEEN");
  });

  it("창을 안 주면 단정하지 않고 기존 동작(UNSEEN)을 유지한다", () => {
    const { verdicts } = matchIssuedInvoices({
      invoices: [],
      expected: [old],
      ourBusinessNumber: OURS,
    });
    expect(verdicts[0].status).toBe("UNSEEN");
  });

  it("대조 불가(상대 번호 없음)가 조회 창 판정보다 우선한다", () => {
    const { verdicts } = matchIssuedInvoices({
      invoices: [],
      expected: [expectation({ ...old, counterpartBusinessNumber: null })],
      ourBusinessNumber: OURS,
      scanWindowFromDate: "2026-05-01",
    });
    expect(verdicts[0].status).toBe("UNMATCHABLE");
  });
});

describe("matchIssuedInvoices — 허용오차는 호출부가 명시할 때만 열린다", () => {
  const withDelta = (delta: number) =>
    [
      scanned(
        invoice({
          amounts: { supplyAmount: 300_000, taxAmount: 30_000 + delta, totalAmount: 330_000 + delta },
        }),
      ),
    ];

  it("기본값 0 에서는 1원 차이도 막고, 명시하면 통과한다", () => {
    const expected = [expectation()];
    expect(
      matchIssuedInvoices({ invoices: withDelta(1), expected, ourBusinessNumber: OURS }).verdicts[0]
        .status,
    ).toBe("NEEDS_REVIEW");
    expect(
      matchIssuedInvoices({
        invoices: withDelta(1),
        expected,
        ourBusinessNumber: OURS,
        amountToleranceWon: 1,
      }).verdicts[0].status,
    ).toBe("CONFIRMED");
  });

  // ── 오너 확정 99원(100원 미만 절삭)의 **경계**. 양성·음성을 함께 둔다.
  it("99원은 흡수해 확정하고, 100원은 확정하지 않는다", () => {
    const expected = [expectation()];
    const run99 = matchIssuedInvoices({
      invoices: withDelta(-99),
      expected,
      ourBusinessNumber: OURS,
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
    });
    expect(run99.verdicts[0].status).toBe("CONFIRMED");

    const run100 = matchIssuedInvoices({
      invoices: withDelta(-100),
      expected,
      ourBusinessNumber: OURS,
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
    });
    expect(run100.verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(run100.verdicts[0].reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
  });

  it("⛔ 흡수한 오차는 조용히 넘어가지 않는다 — AMOUNT_TOLERATED 로 남는다", () => {
    // 오너 요구: "오차가 발생하면 발생했다는 표시는 필요할 것 같다". 쓰기 경로라
    // 조용한 흡수는 절삭인지 입력 오류인지 사후 구분을 없앤다.
    const { verdicts } = matchIssuedInvoices({
      invoices: withDelta(-50),
      expected: [expectation()],
      ourBusinessNumber: OURS,
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
    });
    expect(verdicts[0].status).toBe("CONFIRMED");
    expect(verdicts[0].reasons.map((r) => r.code)).toContain("AMOUNT_TOLERATED");
    expect(verdicts[0].observed.amountDelta).toBe(-50);
  });

  it("완전 일치면 AMOUNT_TOLERATED 를 붙이지 않는다(사유가 노이즈가 되지 않게)", () => {
    const { verdicts } = matchIssuedInvoices({
      invoices: withDelta(0),
      expected: [expectation()],
      ourBusinessNumber: OURS,
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
    });
    expect(verdicts[0].status).toBe("CONFIRMED");
    expect(verdicts[0].reasons).toHaveLength(0);
  });

  it("수정계산서 사유는 「모르는 코드」와 갈라진다", () => {
    const corrective = run([scanned(invoice({ typeCode: "0201" }))], [expectation()]);
    expect(corrective.verdicts[0].reasons.map((r) => r.code)).toContain("CORRECTIVE_DOCUMENT");
    const unknown = run([scanned(invoice({ typeCode: "0303" }))], [expectation()]);
    expect(unknown.verdicts[0].reasons.map((r) => r.code)).toContain("UNVERIFIED_DOCUMENT_TYPE");
    // 둘 다 확정은 막는다 — 사유만 정밀해진 것이지 게이트가 느슨해진 것이 아니다.
    expect(corrective.verdicts[0].status).toBe("NEEDS_REVIEW");
    expect(unknown.verdicts[0].status).toBe("NEEDS_REVIEW");
  });
});
