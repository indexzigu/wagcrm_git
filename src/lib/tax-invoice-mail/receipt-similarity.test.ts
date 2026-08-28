import { describe, it, expect } from "vitest";
import { suggestReceiptMatch, tokenizeName } from "./receipt-similarity";
import type { ExpectedReceivable } from "./expected-receivables";
import type { ParsedEtaxInvoice } from "./etax-xml";
import type { ReceiptVerdict } from "./receipt-match";

/**
 * 유사도 보조 판정의 행위 계약.
 *
 * 고정하는 것 둘 — ①판정 불가(`UNKNOWN`)를 불일치로 세지 않는다 ②모호하면 제안하지
 * 않는다. 이 둘이 무너지면 오너가 「사람이 확인했다」는 흔적과 함께 틀린 계산서를 굳히게
 * 되므로, 아무 제안도 안 하는 것보다 나쁜 상태가 된다.
 *
 * ⏰ 이 파일에는 `now` 기준 픽스처가 없다 — 날짜는 전부 후보의 명시 창과 비교하므로
 * 시간이 지나도 판정이 바뀌지 않는다(P9 시한폭탄 금지).
 *
 * 이름·상호는 전부 가짜다(P0 — public 레포).
 */

const OURS = "2223344444";
const SELLER_BIZ = "1112233333";

function parsed(overrides: Partial<ParsedEtaxInvoice> = {}): ParsedEtaxInvoice {
  return {
    issueId: "202608031234567890123456",
    typeCode: "0101",
    purposeCode: "02",
    writtenDate: "2026-07-31",
    invoicerBusinessNumber: SELLER_BIZ,
    invoicerName: "블루버드컴퍼니",
    invoiceeBusinessNumber: OURS,
    invoiceeName: "우리",
    amounts: { supplyAmount: 4990000, taxAmount: 499000, totalAmount: 5489000 },
    lineItems: [{ sequence: 1, name: "블루버드 여름기획 수수료", quantity: 1, unitPrice: null, supplyAmount: 4990000, taxAmount: 499000 }],
    declaredEncoding: "UTF-8",
    ...overrides,
  };
}

function candidate(overrides: Partial<ExpectedReceivable> = {}): ExpectedReceivable {
  return {
    key: "camp1:SELLER_COMMISSION",
    campaignId: "camp1",
    campaignLabel: "여름기획 3차 블루버드",
    slot: "SELLER_COMMISSION",
    channel: "BRAND_MALL",
    counterpartBusinessNumber: SELLER_BIZ,
    counterpartLabel: "블루버드컴퍼니",
    expectedTotalAmount: 5500000,
    amountBasis: "셀러 수수료",
    amountIsManual: false,
    amountIsEstimate: false,
    trackingField: "sellerInvoiceIssuedAt",
    alreadyMarkedAt: null,
    validWrittenDateFrom: "2026-07-01",
    validWrittenDateTo: "2026-10-01",
    ...overrides,
  };
}

function verdict(overrides: Partial<ReceiptVerdict> = {}): ReceiptVerdict {
  return {
    status: "NEEDS_REVIEW",
    confidence: "ATTACHMENT",
    matchedKey: "camp1:SELLER_COMMISSION",
    candidateKeys: ["camp1:SELLER_COMMISSION"],
    reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다." }],
    observed: {
      issueId: "202608031234567890123456",
      writtenDate: "2026-07-31",
      counterpartBusinessNumber: SELLER_BIZ,
      totalAmount: 5489000,
      expectedTotalAmount: 5500000,
      amountDelta: -11000,
    },
    ...overrides,
  };
}

describe("suggestReceiptMatch", () => {
  it("금액만 어긋난 건에 3신호 근거와 차이액을 붙여 제안한다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict(),
      parsed: parsed(),
      expected: [candidate()],
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.key).toBe("camp1:SELLER_COMMISSION");
    expect(suggestion?.matchedSignalCount).toBe(3);
    expect(suggestion?.evaluatedSignalCount).toBe(3);
    expect(suggestion?.amountDelta).toBe(-11000);
    expect(suggestion?.trackingField).toBe("sellerInvoiceIssuedAt");
  });

  it("내부 관리명과 계산서 표기가 달라도 부분일치로 잡는다", () => {
    // 계산서는 축약형("블루버드"), CRM 은 내부 관리명("여름기획 3차 블루버드").
    const suggestion = suggestReceiptMatch({
      verdict: verdict(),
      parsed: parsed({
        lineItems: [{ sequence: 1, name: "블루버드 광고비", quantity: 1, unitPrice: null, supplyAmount: 1, taxAmount: 0 }],
      }),
      expected: [candidate()],
    });

    expect(suggestion?.signals.find((s) => s.kind === "CAMPAIGN_NAME")?.result).toBe("MATCH");
  });

  it("판정 불가 신호는 불일치가 아니라 모수에서 빠진다", () => {
    // 인코딩 불신이면 파서가 이름을 전부 null 로 비운다 → 이름 2신호가 UNKNOWN.
    // 그 둘을 MISS 로 세면 날짜가 맞아도 바닥에 못 미친다. 여기서 확인하는 것은
    // "0점으로 치지 않는다"이고, 모수가 1이라 제안 자체는 서지 않는 것이 정답이다.
    const suggestion = suggestReceiptMatch({
      verdict: verdict(),
      parsed: parsed({
        invoicerName: null,
        lineItems: [{ sequence: 1, name: null, quantity: 1, unitPrice: null, supplyAmount: 1, taxAmount: 0 }],
        declaredEncoding: "EUC-KR",
      }),
      expected: [candidate()],
    });

    expect(suggestion).toBeNull();
  });

  it("날짜 하나만 맞으면 제안하지 않는다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict(),
      parsed: parsed({
        invoicerName: "전혀다른상호",
        lineItems: [{ sequence: 1, name: "무관한품목", quantity: 1, unitPrice: null, supplyAmount: 1, taxAmount: 0 }],
      }),
      expected: [candidate()],
    });

    expect(suggestion).toBeNull();
  });

  it("최고 점수 후보가 둘이면 제안하지 않는다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict({
        candidateKeys: ["camp1:SELLER_COMMISSION", "camp2:SELLER_COMMISSION"],
        reasons: [{ code: "AMBIGUOUS_MATCH", message: "후보가 둘" }],
      }),
      parsed: parsed(),
      expected: [
        candidate(),
        candidate({ key: "camp2:SELLER_COMMISSION", campaignId: "camp2" }),
      ],
    });

    expect(suggestion).toBeNull();
  });

  it("이미 수취 완료로 기록된 건은 후보에서 뺀다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict(),
      parsed: parsed(),
      expected: [candidate({ alreadyMarkedAt: "2026-08-01T00:00:00.000Z" })],
    });

    expect(suggestion).toBeNull();
  });

  it("사업자번호가 안 잡힌 건은 기대 건 전체에서 후보를 추린다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict({
        matchedKey: null,
        candidateKeys: [],
        reasons: [{ code: "NO_EXPECTED_MATCH", message: "대응 정산 건 없음" }],
      }),
      parsed: parsed(),
      expected: [
        candidate({ key: "other:SUPPLIER_GOODS", campaignId: "other", campaignLabel: "무관한 건", counterpartLabel: "다른회사" }),
        candidate(),
      ],
    });

    expect(suggestion?.key).toBe("camp1:SELLER_COMMISSION");
  });

  it("확인 완료·우리 발행분에는 제안을 붙이지 않는다", () => {
    for (const status of ["VERIFIED", "ISSUED_BY_US", "NOT_OURS"] as const) {
      expect(
        suggestReceiptMatch({ verdict: verdict({ status }), parsed: parsed(), expected: [candidate()] }),
      ).toBeNull();
    }
  });

  it("CRM 에 없는 발행자(경비 계산서)에는 제안을 붙이지 않는다", () => {
    const suggestion = suggestReceiptMatch({
      verdict: verdict({
        matchedKey: null,
        candidateKeys: [],
        reasons: [{ code: "UNRELATED_COUNTERPART", message: "모르는 발행자" }],
      }),
      parsed: parsed(),
      expected: [candidate()],
    });

    expect(suggestion).toBeNull();
  });
});

describe("tokenizeName", () => {
  it("표기 차이를 흡수하고 불용어·1자 토큰을 뺀다", () => {
    const tokens = tokenizeName("(주)블루버드 · 여름기획 3차 수수료");
    expect(tokens.has("블루버드")).toBe(true);
    expect(tokens.has("여름기획")).toBe(true);
    // 불용어
    expect(tokens.has("수수료")).toBe(false);
    // 1자 토큰("주")은 부분일치에서 거의 모든 것과 맞아 신호를 무너뜨린다.
    expect(tokens.has("주")).toBe(false);
  });
});
