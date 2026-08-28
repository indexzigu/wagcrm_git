import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { judgeReceipt, SUB_HUNDRED_TRUNCATION_TOLERANCE_WON } from "./receipt-match";
import type { ExpectedReceivable } from "./expected-receivables";
import { buildExpectedReceivables } from "./expected-receivables";
import type { ParsedEtaxInvoice } from "./etax-xml";

/**
 * 수취 판정 계약 테스트.
 *
 * 고정하는 것은 단 하나 — **틀린 계산서가 「수취 완료」로 오판되지 않는다.**
 * 이 계약이 깨지면 오너가 검증을 건너뛴 채 잘못된 계산서를 확정하게 되므로, 아무것도
 * 안 하는 것보다 나쁜 상태가 된다. 완화는 오너 승인 사안이다.
 *
 * 값은 전부 가짜다(P0 — public 레포).
 */

const OURS = "2223344444";
const SELLER_BIZ = "1112233333";
const OTHER_BIZ = "9998877777";

function parsed(overrides: Partial<ParsedEtaxInvoice> = {}): ParsedEtaxInvoice {
  return {
    issueId: "202608031234567890123456",
    typeCode: "0101",
    purposeCode: "02",
    writtenDate: "2026-07-31",
    invoicerBusinessNumber: SELLER_BIZ,
    invoicerName: "테스트셀러사",
    invoiceeBusinessNumber: OURS,
    invoiceeName: "우리",
    amounts: { supplyAmount: 1000000, taxAmount: 100000, totalAmount: 1100000 },
    lineItems: [],
    declaredEncoding: "UTF-8",
    ...overrides,
  };
}

function expectedReceivable(overrides: Partial<ExpectedReceivable> = {}): ExpectedReceivable {
  return {
    key: "camp1:SELLER_COMMISSION",
    campaignId: "camp1",
    campaignLabel: "캠페인",
    slot: "SELLER_COMMISSION",
    channel: "BRAND_MALL",
    counterpartBusinessNumber: SELLER_BIZ,
    counterpartLabel: "셀러",
    expectedTotalAmount: 1100000,
    amountBasis: "셀러 수수료",
    amountIsManual: false,
    // 셀러 수수료는 요율에서 나온 **파생 확정값**이라 추정이 아니다 — 여기서 true 로
    // 두면 이 파일의 기존 「금액 불일치」 단언들이 통째로 다른 사유로 바뀐다.
    amountIsEstimate: false,
    trackingField: "sellerInvoiceIssuedAt",
    alreadyMarkedAt: null,
    validWrittenDateFrom: null,
    validWrittenDateTo: null,
    ...overrides,
  };
}

const base = { ourBusinessNumber: OURS, expected: [expectedReceivable()] };

describe("수취 판정 — 정상 경로", () => {
  it("첨부·수신처·금액·승인번호가 전부 맞으면 VERIFIED", () => {
    const verdict = judgeReceipt({ ...base, parsed: parsed() });
    expect(verdict.status).toBe("VERIFIED");
    expect(verdict.confidence).toBe("ATTACHMENT");
    expect(verdict.matchedKey).toBe("camp1:SELLER_COMMISSION");
    expect(verdict.reasons).toEqual([]);
  });
});

describe("⛔ 오판 방지 계약 — 아래는 절대 VERIFIED 가 되지 않는다", () => {
  it("금액 불일치", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ amounts: { supplyAmount: 900000, taxAmount: 90000, totalAmount: 990000 } }),
    });
    expect(verdict.status).not.toBe("VERIFIED");
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
    expect(verdict.observed.amountDelta).toBe(-110000);
  });

  it("1원만 달라도 통과시키지 않는다(기본 허용오차 0)", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ amounts: { supplyAmount: 1000000, taxAmount: 100001, totalAmount: 1100001 } }),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
  });

  /**
   * 금액 불일치가 **결함이 아닌 경우**가 실재한다 — 통과 광고비는 계산서에만 실리고
   * 캠페인에는 기록하지 않는 것이 정상이다(오너 확인, 현행 UI 에 칸이 없다). 이때 사유가
   * 「금액이 다릅니다」로만 끝나면 정상 상태가 오류처럼만 보인다. 품목명이 그 차이를 설명한다.
   *
   * ⛔ 판정은 그대로 `NEEDS_REVIEW` 다 — 품목명은 **설명**이지 통과 근거가 아니다.
   */
  it("금액 불일치 사유에 품목명을 실어 차이의 원인을 말한다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({
        amounts: { supplyAmount: 2396450, taxAmount: 239645, totalAmount: 2636095 },
        lineItems: [
          { sequence: 1, name: "테스트딜 1차", quantity: null, unitPrice: null, supplyAmount: 396450, taxAmount: 39645 },
          { sequence: 2, name: "광고비", quantity: null, unitPrice: null, supplyAmount: 2000000, taxAmount: 200000 },
        ],
      }),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    const message = verdict.reasons.find((r) => r.code === "AMOUNT_MISMATCH")?.message ?? "";
    expect(message).toContain("광고비");
    expect(message).toContain("테스트딜 1차");
  });

  /** 음성 대조군 — 품목이 없으면 사유에 품목 문구가 붙지 않는다(빈 「품목:」 꼬리 금지). */
  it("품목이 없으면 사유에 품목 문구를 붙이지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ amounts: { supplyAmount: 900000, taxAmount: 90000, totalAmount: 990000 } }),
    });
    expect(verdict.reasons.find((r) => r.code === "AMOUNT_MISMATCH")?.message).not.toContain("품목");
  });

  it("타 사업자 앞 발행 — NOT_OURS 로 끊고 매칭을 시도하지도 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ invoiceeBusinessNumber: OTHER_BIZ }),
    });
    expect(verdict.status).toBe("NOT_OURS");
    expect(verdict.matchedKey).toBeNull();
    expect(verdict.reasons.map((r) => r.code)).toEqual(["NOT_ADDRESSED_TO_US"]);
  });

  /**
   * 실측(2026-08-04): 세금계산서 전용 폴더에는 **발행 메일도 섞여 있다**(오너 제공 샘플이
   * 우리가 발행한 건이었다). 국세청 보안메일 비밀번호는 양방향 모두 우리 사업자번호라
   * 똑같이 열린다 — 그래서 방향을 안 가르면 우리가 끊은 계산서가 「남의 계산서」가 된다.
   */
  it("우리가 발행한 건은 ISSUED_BY_US — NOT_OURS 와 섞지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ invoicerBusinessNumber: OURS, invoiceeBusinessNumber: OTHER_BIZ }),
    });
    expect(verdict.status).toBe("ISSUED_BY_US");
    expect(verdict.status).not.toBe("NOT_OURS");
    expect(verdict.reasons.map((r) => r.code)).toEqual(["ISSUED_BY_US"]);
  });

  it("발행 건도 VERIFIED 가 되지 않는다(수취 대상이 아니다)", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ invoicerBusinessNumber: OURS, invoiceeBusinessNumber: OTHER_BIZ }),
    });
    expect(verdict.status).not.toBe("VERIFIED");
    expect(verdict.matchedKey).toBeNull();
  });

  it("중복 발행 — 같은 승인번호를 이미 봤으면 확인 필요", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed(),
      seenIssueIds: ["202608031234567890123456"],
    });
    expect(verdict.status).not.toBe("VERIFIED");
    expect(verdict.reasons.map((r) => r.code)).toContain("DUPLICATE_ISSUE");
  });

  it("첨부 없음(제목 폴백) — 금액이 맞아떨어져도 VERIFIED 금지", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: null,
      fallbackCounterpartBusinessNumber: SELLER_BIZ,
    });
    expect(verdict.confidence).toBe("SUBJECT_FALLBACK");
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("NO_ATTACHMENT_EVIDENCE");
  });

  /**
   * 오너 확인: 계산서 첨부는 통상 우리 사업자번호를 비밀번호로 요구한다.
   * "첨부가 없다"와 "못 열었다"는 처방이 다르다 — 후자는 오너가 수동으로 열면 바로 끝난다.
   */
  it("비밀번호가 걸린 첨부는 '첨부 없음'이 아니라 전용 사유로 말한다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: null,
      fallbackCounterpartBusinessNumber: SELLER_BIZ,
      attachmentPasswordSuspected: true,
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("ATTACHMENT_PASSWORD_PROTECTED");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("NO_ATTACHMENT_EVIDENCE");
  });

  it("기대 금액 기준이 미확정이면 대조했다고 말하지 않는다(우리몰 물품대금)", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [expectedReceivable({ expectedTotalAmount: null, slot: "SUPPLIER_GOODS" })],
      parsed: parsed(),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("EXPECTED_AMOUNT_UNKNOWN");
  });

  it("대응하는 정산 건이 없으면 확인 필요", () => {
    const verdict = judgeReceipt({ ...base, expected: [], parsed: parsed() });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("NO_EXPECTED_MATCH");
  });
});

/**
 * ⛔ 경비 계산서와 「잘못 발행된 셀러 계산서」를 같은 칸에 넣지 않는다.
 * 둘 다 매칭에 실패하지만 처방이 정반대다 — 전자는 접어도 되고 후자는 반드시 봐야 한다.
 * 화면이 이 구분 없이 "매칭 실패"를 접으면 이 엔진의 존재 이유가 무너진다.
 */
describe("매칭 실패의 두 갈래를 가른다", () => {
  it("CRM 에 없는 발행자 → 경비 추정(UNRELATED_COUNTERPART)", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [],
      parsed: parsed({ invoicerBusinessNumber: OTHER_BIZ }),
      knownCounterpartBusinessNumbers: [SELLER_BIZ],
    });
    expect(verdict.reasons.map((r) => r.code)).toContain("UNRELATED_COUNTERPART");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("NO_EXPECTED_MATCH");
  });

  it("아는 상대인데 정산 건이 없으면 → 진짜 확인 대상(NO_EXPECTED_MATCH)", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [],
      parsed: parsed(),
      knownCounterpartBusinessNumbers: [SELLER_BIZ],
    });
    expect(verdict.reasons.map((r) => r.code)).toContain("NO_EXPECTED_MATCH");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("UNRELATED_COUNTERPART");
  });

  it("어느 쪽이든 상태는 NEEDS_REVIEW — 조용히 접지 않는다", () => {
    for (const invoicer of [SELLER_BIZ, OTHER_BIZ]) {
      const verdict = judgeReceipt({
        ...base,
        expected: [],
        parsed: parsed({ invoicerBusinessNumber: invoicer }),
        knownCounterpartBusinessNumbers: [SELLER_BIZ],
      });
      expect(verdict.status).toBe("NEEDS_REVIEW");
    }
  });

  it("known 목록을 안 주면 구분하지 않는다(하이픈 표기도 정규화해 비교)", () => {
    const withoutList = judgeReceipt({ ...base, expected: [], parsed: parsed() });
    expect(withoutList.reasons.map((r) => r.code)).toContain("NO_EXPECTED_MATCH");

    const hyphenated = judgeReceipt({
      ...base,
      expected: [],
      parsed: parsed(),
      knownCounterpartBusinessNumbers: ["111-22-33333"],
    });
    expect(hyphenated.reasons.map((r) => r.code)).toContain("NO_EXPECTED_MATCH");
  });

  it("같은 셀러·같은 금액 정산 건이 둘이면 특정하지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [
        expectedReceivable({ key: "camp1:SELLER_COMMISSION" }),
        expectedReceivable({ key: "camp2:SELLER_COMMISSION", campaignId: "camp2" }),
      ],
      parsed: parsed(),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.matchedKey).toBeNull();
    expect(verdict.reasons.map((r) => r.code)).toContain("AMBIGUOUS_MATCH");
    expect(verdict.candidateKeys).toHaveLength(2);
  });

  it("확인되지 않은 계산서 종류 코드는 통과시키지 않는다", () => {
    const verdict = judgeReceipt({ ...base, parsed: parsed({ typeCode: "0102" }) });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("UNVERIFIED_DOCUMENT_TYPE");
  });

  /**
   * 수정세금계산서(`0201`)는 실물 3건으로 확정된 **아는 코드**다(2026-08-06) — 취소분은
   * 음수 금액이라 단건 대조가 원리적으로 불가능하고, 재발행분은 체인 합산이 필요하다.
   * "모르는 코드"(UNVERIFIED)와 칸을 합치면 처방이 갈리는 두 상황이 한 문구가 된다.
   */
  it("수정세금계산서(0201)는 전용 사유로 가르고, 금액이 맞아떨어져도 VERIFIED 금지", () => {
    const verdict = judgeReceipt({ ...base, parsed: parsed({ typeCode: "0201" }) });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.status).not.toBe("VERIFIED");
    expect(verdict.reasons.map((r) => r.code)).toContain("CORRECTIVE_DOCUMENT");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("UNVERIFIED_DOCUMENT_TYPE");
  });

  it("작성일자를 못 읽으면 통과시키지 않는다", () => {
    const verdict = judgeReceipt({ ...base, parsed: parsed({ writtenDate: null }) });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("WRITTEN_DATE_MISSING");
  });

  it("작성일자가 캠페인 타당 창 밖이면 사유를 붙인다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [
        expectedReceivable({ validWrittenDateFrom: "2026-08-01", validWrittenDateTo: "2026-08-31" }),
      ],
      parsed: parsed({ writtenDate: "2026-07-31" }),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("WRITTEN_DATE_OUT_OF_RANGE");
  });
});

describe("이미 완료 기록된 건", () => {
  it("ALREADY_MARKED 는 사유로 남기되 검증 자체는 막지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [expectedReceivable({ alreadyMarkedAt: "2026-08-01T00:00:00.000Z" })],
      parsed: parsed(),
    });
    expect(verdict.status).toBe("VERIFIED");
    expect(verdict.reasons.map((r) => r.code)).toEqual(["ALREADY_MARKED"]);
  });
});

describe("허용오차를 명시하면 그만큼만 봐준다", () => {
  it("±1원 허용 시 1원 차이는 통과, 2원 차이는 불통과", () => {
    const one = judgeReceipt({
      ...base,
      amountToleranceWon: 1,
      parsed: parsed({ amounts: { supplyAmount: 1000000, taxAmount: 100001, totalAmount: 1100001 } }),
    });
    expect(one.status).toBe("VERIFIED");

    const two = judgeReceipt({
      ...base,
      amountToleranceWon: 1,
      parsed: parsed({ amounts: { supplyAmount: 1000000, taxAmount: 100002, totalAmount: 1100002 } }),
    });
    expect(two.status).toBe("NEEDS_REVIEW");
  });
});

/**
 * 확정 정책(오너 2026-08-06): 브랜드사의 100원 미만 절삭 관행만 흡수한다.
 * ⛔ 이 블록의 문구·경계 assert 를 지우면 안 된다 — 「판정 문구가 테스트에 안 잡혀 있어
 * 바꿔도 전 스위트가 통과한」 실사고가 이 트랙에 있다(음성 대조군 의무).
 */
describe("확정 허용오차 — 100원 미만 절삭(99원)", () => {
  const at = (totalAmount: number) =>
    judgeReceipt({
      ...base,
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
      parsed: parsed({ amounts: { supplyAmount: 1000000, taxAmount: 100000, totalAmount } }),
    });

  it("정책 상수는 99원이다 — 변경은 오너 승인 사안", () => {
    expect(SUB_HUNDRED_TRUNCATION_TOLERANCE_WON).toBe(99);
  });

  it("99원 차이(절삭 수준)는 통과하되 AMOUNT_TOLERATED 로 오차 사실을 남긴다", () => {
    const verdict = at(1100000 - 99);
    expect(verdict.status).toBe("VERIFIED");
    const tolerated = verdict.reasons.find((r) => r.code === "AMOUNT_TOLERATED");
    expect(tolerated).toBeDefined();
    expect(tolerated?.message).toContain("허용오차 이내");
    expect(tolerated?.message).toContain("차이 -99원");
    expect(verdict.observed.amountDelta).toBe(-99);
  });

  it("음성 대조군 — 100원 차이는 절삭이 아니다: AMOUNT_MISMATCH 로 차단", () => {
    const verdict = at(1100000 - 100);
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("AMOUNT_TOLERATED");
  });

  it("음성 대조군 — 정확히 일치하면 AMOUNT_TOLERATED 표시를 붙이지 않는다(표시 남발 금지)", () => {
    const verdict = at(1100000);
    expect(verdict.status).toBe("VERIFIED");
    expect(verdict.reasons).toEqual([]);
  });

  it("judgeReceipt 의 파라미터 기본값은 여전히 0 — 정책은 호출부가 명시한다", () => {
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ amounts: { supplyAmount: 1000000, taxAmount: 100000, totalAmount: 1100000 - 99 } }),
    });
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
  });

  /**
   * 라우트가 정책 상수를 실제로 넘기는지 소스로 고정한다 — 순수 함수 쪽 테스트만으로는
   * 호출부가 기본값 0 으로 되돌아가는 회귀(정책이 조용히 꺼짐)를 못 잡는다.
   */
  it("수취 조회 라우트는 정책 상수를 명시적으로 전달한다(소스 스캔)", () => {
    const routeSource = fs.readFileSync(
      path.join(__dirname, "../../app/api/settlement/tax-invoice-receipts/route.ts"),
      "utf8",
    );
    expect(routeSource).toContain("amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON");
  });
});

/**
 * 「계산서가 틀렸다」와 「우리 추정이 못 맞춘다」를 가르는 계약(2-B, 설계 §9-10).
 *
 * 우리몰 공급사 매입계산서는 **상품별·월별**로 끊겨 캠페인 경계와 정렬되지 않는다 —
 * 그 축에서 공식(`총매출 − 영업수익`)은 실물을 재현할 수 없다는 것이 실측으로 확정됐다.
 * 그때 나오는 차이를 `AMOUNT_MISMATCH` 로 말하면 오너가 **상대를 의심**하게 되는데,
 * 정작 필요한 동작은 **우리 쪽 수기 입력**이다. 처방이 정반대라 사유를 갈라야 한다.
 */
describe("§9-10 공식 추정 기대액 — 「금액 불일치」로 단정하지 않는다", () => {
  const goodsEstimate = expectedReceivable({
    key: "camp1:SUPPLIER_GOODS",
    slot: "SUPPLIER_GOODS",
    amountBasis: "물품비 = 총매출 − 영업수익(공식 추정)",
    amountIsManual: false,
    amountIsEstimate: true,
  });

  it("추정인데 금액이 어긋나면 AMOUNT_MISMATCH 가 아니라 EXPECTED_AMOUNT_ESTIMATED 다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [goodsEstimate],
      parsed: parsed({ amounts: { supplyAmount: 5_000_000, taxAmount: 500_000, totalAmount: 5_500_000 } }),
    });
    const codes = verdict.reasons.map((r) => r.code);
    expect(codes).toContain("EXPECTED_AMOUNT_ESTIMATED");
    expect(codes).not.toContain("AMOUNT_MISMATCH");
    // 여전히 사람이 봐야 한다 — 사유만 바뀌지 통과되는 것이 아니다.
    expect(verdict.status).toBe("NEEDS_REVIEW");
  });

  it("사유 문구가 **오너가 할 일**을 말한다(상대 의심이 아니라 수기 입력)", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [goodsEstimate],
      parsed: parsed({ amounts: { supplyAmount: 5_000_000, taxAmount: 500_000, totalAmount: 5_500_000 } }),
    });
    const message = verdict.reasons.find((r) => r.code === "EXPECTED_AMOUNT_ESTIMATED")?.message ?? "";
    expect(message).toContain("수기 물품대금");
  });

  it("⛔ 음성 대조군 — 셀러 수수료는 추정이 아니므로 그대로 AMOUNT_MISMATCH 다", () => {
    // `amountIsManual: false` 는 셀러 수수료 슬롯도 마찬가지다. 두 필드를 같은 뜻으로
    // 쓰면 **진짜 금액 불일치가 「추정이라 어쩔 수 없다」로 덮인다** — 이 단언이 그 혼동을
    // 막는다(셀러 수수료는 요율에서 나온 파생 확정값이다).
    const verdict = judgeReceipt({
      ...base,
      parsed: parsed({ amounts: { supplyAmount: 900_000, taxAmount: 90_000, totalAmount: 990_000 } }),
    });
    const codes = verdict.reasons.map((r) => r.code);
    expect(codes).toContain("AMOUNT_MISMATCH");
    expect(codes).not.toContain("EXPECTED_AMOUNT_ESTIMATED");
  });

  it("음성 대조군 — 추정이어도 금액이 맞으면 그대로 VERIFIED 다", () => {
    // 공식이 우연히 맞는 경우까지 막지 않는다. 이 절은 **어긋났을 때의 어휘**만 바꾼다.
    const verdict = judgeReceipt({
      ...base,
      expected: [goodsEstimate],
      parsed: parsed(),
    });
    expect(verdict.status).toBe("VERIFIED");
  });

  it("수기값이 들어온 물품대금은 추정이 아니다 — 어긋나면 진짜 불일치", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [
        expectedReceivable({
          key: "camp1:SUPPLIER_GOODS",
          slot: "SUPPLIER_GOODS",
          amountIsManual: true,
          amountIsEstimate: false,
        }),
      ],
      parsed: parsed({ amounts: { supplyAmount: 5_000_000, taxAmount: 500_000, totalAmount: 5_500_000 } }),
    });
    expect(verdict.reasons.map((r) => r.code)).toContain("AMOUNT_MISMATCH");
  });
});

/**
 * 엔진이 `amountIsEstimate` 를 **실제로 그 조합에만** 켜는지 — 판정 쪽 계약만으로는
 * 「엔진이 늘 false 를 준다」는 회귀를 못 잡는다(그러면 위 분기가 죽은 코드가 된다).
 */
describe("§9-10 amountIsEstimate 는 공급사 물품대금 × 수기 미입력에서만 참이다", () => {
  const facts = {
    campaignId: "c1",
    campaignLabel: "캠페인",
    salesChannel: "OWN_MALL",
    actualSales: 11_000_000,
    settlementSales: 5_500_000,
    sellerExpense: 2_200_000,
    sellerBusinessNumber: "1234567890",
    sellerTaxType: "BUSINESS",
    sellerLabel: "셀러",
    partnerBusinessNumber: "1231231231",
    partnerLabel: "공급사",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
  };

  it("수기 미입력 물품대금은 추정이고, 셀러 수수료는 같은 캠페인에서도 추정이 아니다", () => {
    const rows = buildExpectedReceivables(facts);
    const goods = rows.find((r) => r.slot === "SUPPLIER_GOODS");
    const commission = rows.find((r) => r.slot === "SELLER_COMMISSION");
    expect(goods?.amountIsEstimate, "공식 폴백 물품대금은 추정이다").toBe(true);
    expect(commission?.amountIsEstimate, "셀러 수수료는 파생 확정값이다").toBe(false);
  });

  it("수기값이 들어오면 추정이 아니다", () => {
    const rows = buildExpectedReceivables({ ...facts, manualGoodsCost: 5_600_000 });
    expect(rows.find((r) => r.slot === "SUPPLIER_GOODS")?.amountIsEstimate).toBe(false);
  });
});

/**
 * 「묶여서 왔을 수 있다」를 말하는 계약(2-B, 설계 §9-10).
 *
 * 실측: **정산 그룹이 아닌 별개 캠페인 2건**이 계산서 1장으로 묶인 건이 실재한다
 * (`groupId` 가 둘 다 null 이라 기존 그룹 합산 로직이 원천적으로 못 덮는다). 종전 판정은
 * 「금액이 일치하는 건이 없습니다」로 끝나 **무엇을 하라는 것인지 말하지 않았다.**
 *
 * ⛔ 자동 확정은 하지 않는다(오너 확정) — 이 사유의 값어치는 「안 왔다」로 보이던 것을
 * 「묶여서 왔을 수 있다」로 바꾸는 것뿐이다.
 */
describe("§9-10 합산 수취 후보 — 표면화만 하고 확정하지 않는다", () => {
  const twoOpen = [
    expectedReceivable({ key: "campA:SELLER_COMMISSION", campaignId: "campA", expectedTotalAmount: 700_000 }),
    expectedReceivable({ key: "campB:SELLER_COMMISSION", campaignId: "campB", expectedTotalAmount: 400_000 }),
  ];

  it("합이 어느 단건보다 계산서에 가까우면 「묶음으로 보인다」고 말한다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: twoOpen,
      // 합 1,100,000 과 정확히 같다. 단건(700,000 / 400,000)은 둘 다 한참 멀다.
      parsed: parsed(),
    });
    const codes = verdict.reasons.map((r) => r.code);
    expect(codes).toContain("MERGED_CANDIDATE");
    // ⛔ 그래도 확정하지 않는다 — 여러 캠페인 필드를 계산서 1장으로 찍지 않는다.
    expect(verdict.status).toBe("NEEDS_REVIEW");
    expect(verdict.matchedKey).toBeNull();
  });

  it("허용오차 밖의 차이여도 말해 준다 — 판정이 아니라 관찰이다", () => {
    // 실측 건의 차이는 만원대였다. 허용오차 안에 들 것을 조건으로 하면 그 건을 못 잡는다.
    const verdict = judgeReceipt({
      ...base,
      expected: twoOpen,
      parsed: parsed({
        amounts: { supplyAmount: 1_010_000, taxAmount: 101_000, totalAmount: 1_111_000 },
      }),
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
    });
    expect(verdict.reasons.map((r) => r.code)).toContain("MERGED_CANDIDATE");
  });

  it("사유 문구가 **오너가 할 일**을 말한다(직접 완료 처리)", () => {
    const verdict = judgeReceipt({ ...base, expected: twoOpen, parsed: parsed() });
    const message = verdict.reasons.find((r) => r.code === "MERGED_CANDIDATE")?.message ?? "";
    expect(message).toContain("2건");
    expect(message).toContain("자동 확정하지 않으니");
  });

  it("⛔ 음성 대조군 — 합이 단건보다 멀면 아무 말도 하지 않는다", () => {
    // 계산서가 한 건(700,000)에 가깝다. 이때 「묶음」이라고 말하면 오히려 오도한다.
    const verdict = judgeReceipt({
      ...base,
      expected: twoOpen,
      parsed: parsed({ amounts: { supplyAmount: 660_000, taxAmount: 66_000, totalAmount: 726_000 } }),
    });
    expect(verdict.reasons.map((r) => r.code)).not.toContain("MERGED_CANDIDATE");
  });

  it("⛔ 음성 대조군 — 단건이 정확히 맞으면 묶음을 묻지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [
        expectedReceivable({ key: "campA:SELLER_COMMISSION", campaignId: "campA", expectedTotalAmount: 1_100_000 }),
        expectedReceivable({ key: "campB:SELLER_COMMISSION", campaignId: "campB", expectedTotalAmount: 400_000 }),
      ],
      parsed: parsed(),
    });
    expect(verdict.status).toBe("VERIFIED");
    expect(verdict.reasons.map((r) => r.code)).not.toContain("MERGED_CANDIDATE");
  });

  it("⛔ 금액을 모르는 기대 건이 섞이면 합을 만들지 않는다", () => {
    // 아는 것만 더하면 「일부만 반영된 합계」가 완전한 합계처럼 보이는 오답이 된다.
    const verdict = judgeReceipt({
      ...base,
      expected: [
        expectedReceivable({ key: "campA:SELLER_COMMISSION", campaignId: "campA", expectedTotalAmount: 700_000 }),
        expectedReceivable({ key: "campB:SELLER_COMMISSION", campaignId: "campB", expectedTotalAmount: null }),
      ],
      parsed: parsed(),
    });
    expect(verdict.reasons.map((r) => r.code)).not.toContain("MERGED_CANDIDATE");
  });

  /**
   * ⛔ 교차 검증 적발(2026-08-08). 초판은 docstring 에 「열린 기대 건」이라 적어 놓고
   * 필터가 없어서, **다른 계산서로 이미 종결된 건**이 합에 섞였다. 그 결과 실제로는
   * 1건만 열려 있는데 「2건을 묶어 발행됐다」고 말했고, 이 사유는 「직접 완료 처리해
   * 주세요」로 끝나므로 **오너를 잘못된 동작으로 유도**했다.
   */
  it("⛔ 이미 완료로 기록된 기대 건은 합산에 넣지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [
        // A 는 이미 다른 계산서로 종결됐다. 열린 것은 B 하나뿐이다.
        expectedReceivable({
          key: "campA:SELLER_COMMISSION",
          campaignId: "campA",
          expectedTotalAmount: 700_000,
          alreadyMarkedAt: "2026-07-01T00:00:00.000Z",
        }),
        expectedReceivable({ key: "campB:SELLER_COMMISSION", campaignId: "campB", expectedTotalAmount: 400_000 }),
      ],
      // 두 건의 합(1,100,000)과 정확히 같다 — 필터가 없으면 「2건 묶음」이라고 오판한다.
      parsed: parsed(),
    });
    expect(verdict.reasons.map((r) => r.code)).not.toContain("MERGED_CANDIDATE");
  });

  it("완료된 건을 뺀 뒤에도 2건 이상 남아야 묶음을 묻는다", () => {
    // 열린 건이 2건이면 정상 동작한다 — 위 필터가 기능 자체를 죽이지 않았음을 확인한다.
    const verdict = judgeReceipt({
      ...base,
      expected: [
        ...twoOpen,
        expectedReceivable({
          key: "campC:SELLER_COMMISSION",
          campaignId: "campC",
          expectedTotalAmount: 9_000_000,
          alreadyMarkedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      parsed: parsed(),
    });
    const merged = verdict.reasons.find((r) => r.code === "MERGED_CANDIDATE");
    expect(merged).toBeDefined();
    // 문구의 건수도 **열린 건 기준**이어야 한다(완료분을 세면 오너가 3건을 찾는다).
    expect(merged?.message).toContain("2건");
    expect(merged?.message).not.toContain("3건");
  });

  it("후보가 하나뿐이면 묶음을 묻지 않는다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [expectedReceivable({ expectedTotalAmount: 700_000 })],
      parsed: parsed(),
    });
    expect(verdict.reasons.map((r) => r.code)).not.toContain("MERGED_CANDIDATE");
  });
});

/**
 * ⛔ 게이트 순서 회귀(2026-08-08, 동료 세션 실측 대조에서 제기) — 실제 프로덕션에
 * `amountIsEstimate: true` 인데 공식이 우연히 실물과 오차 0 으로 맞은 건이 1건
 * 있었다(우리몰 공급사 물품대금 1건, `SUPPLIER_GOODS` 슬롯). 그 건에서 확인이 필요했던
 * 것: `EXPECTED_AMOUNT_ESTIMATED` 판정이 **금액이 실제로 어긋났을 때만** 발동하는가,
 * 아니면 `amountIsEstimate` 플래그만 보고 금액이 맞아도 잘못 뜨는가.
 *
 * 답은 구조적으로 후자가 될 수 없다 — `matched` 를 고르는 §4(금액으로 후보 특정)와
 * 사유를 붙이는 아래 블록이 **같은 `withinTolerance` 판정을 공유**한다. `matched` 가
 * `amountMatches`(허용오차 안에서 맞는 후보)로 정해지면 그 시점에 이미
 * `withinTolerance(expectedAmount)` 가 참이므로, 아래 `!withinTolerance` 분기 자체를
 * 타지 않는다 — "맞았는데 나중에 추정 사유로 걸리는" 경로가 없다.
 */
describe("§9-10 게이트 순서 — amountIsEstimate 는 실제로 어긋났을 때만 발동한다", () => {
  const estimateItem = expectedReceivable({
    key: "camp1:SUPPLIER_GOODS",
    slot: "SUPPLIER_GOODS",
    amountIsManual: false,
    amountIsEstimate: true,
  });

  it("추정인데 공식이 우연히 실물과 정확히 맞으면 VERIFIED다 — EXPECTED_AMOUNT_ESTIMATED 가 뜨면 안 된다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [{ ...estimateItem, expectedTotalAmount: 5_000_000 }],
      parsed: parsed({ amounts: { supplyAmount: 4_545_455, taxAmount: 454_545, totalAmount: 5_000_000 } }),
    });
    expect(verdict.status).toBe("VERIFIED");
    expect(verdict.reasons).toEqual([]);
  });

  it("음성 대조군 — 추정이고 실제로 어긋나면 그때는 EXPECTED_AMOUNT_ESTIMATED 다", () => {
    const verdict = judgeReceipt({
      ...base,
      expected: [{ ...estimateItem, expectedTotalAmount: 8_000_000 }],
      parsed: parsed({ amounts: { supplyAmount: 4_545_455, taxAmount: 454_545, totalAmount: 5_000_000 } }),
    });
    expect(verdict.reasons.map((r) => r.code)).toContain("EXPECTED_AMOUNT_ESTIMATED");
    expect(verdict.status).toBe("NEEDS_REVIEW");
  });
});
