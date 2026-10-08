import { describe, expect, it } from "vitest";
import { isSettlementStatementSubject, parseSettlementStatement } from "./brand-statement";

// 메일함 실측(2026-10-08) 두 형식의 **구조**를 그대로 옮긴 픽스처 — 이름·금액은 가짜다(P0).
const OURS = "우리상사";

const CLOSING_TABLE = `안녕하세요.
브랜드A 담당자입니다.

26년 9월 마감정산서 전달드리오니 검토 부탁드립니다.

확인 후 이상이 없으시면 9월 말일자로 판매수수료에 대한 세금계산서 발행을 요청드리며
대금은 10월 20일(화)까지 지급해 주시면 감사하겠습니다.

브랜드A 정산내역서

파트너 정보 파트너명 우리상사

프로모션 정보 프로모션명 26년 9월 가나다 공구

세금계산서 발행 정산방식 정산월 최종정산금 발행주체

총 매출 9월 1,000,000 브랜드A

판매 수수료 9월 450,000 우리상사

대금 지급 구분 금액 일자

우리상사 ▶브랜드A 550,000 10월 20일(화)

매출 상세내역 공동구매 구분 ... 합계 (vat포함) 10 1,000,000
450,000`;

const OWN_MALL_TWO_BLOCKS = `안녕하세요.

라마바님의 자사몰 공구 판매내역 송부드립니다.

자사몰 마감기준에 따라 08/28일까지의 결제건은 8월 매출, 이후
08/29~09/02일까지의 결제건은 09월 매출로 정산됩니다.

*\t행사기간 : 2026-08-27 ~ 2026-08-28 (8월 매출분)
*\t우리상사 → 브랜드A 세금계산서 발행일자 : 2026-08-31
*\t세금계산서 발행 시 금액(vat포함) : 1,203,150 원
*\t브랜드A → 우리상사 대금 지급 일자 : 2026-09-18 (금요일)

*\t행사기간 : 2026-08-29 ~ 2026-09-02 (9월 매출분)
*\t우리상사 → 브랜드A 세금계산서 발행일자 : 2026-09-03
*\t세금계산서 발행 시 금액(vat포함) : 805,200 원
*\t브랜드A → 우리상사 대금 지급 일자 : 2026-09-18 (금요일)

내용 확인 여부 회신 및 세금계산서 발행 부탁드리며,`;

describe("parseSettlementStatement — 마감정산서(표)", () => {
  it("우리가 발행하는 판매 수수료 행은 ISSUE, 브랜드가 발행하는 총 매출 행은 RECEIVE — 작성일은 그 달 말일", () => {
    const parsed = parseSettlementStatement({
      subject: "[브랜드A] 26년 9월 가나다님(우리상사) - 마감정산서 검토 요청",
      text: CLOSING_TABLE,
      ourName: OURS,
    });
    expect(parsed?.format).toBe("CLOSING_TABLE");
    expect(parsed?.promotionLabel).toBe("26년 9월 가나다 공구");
    expect(parsed?.invoices).toEqual([
      { direction: "RECEIVE", issuerLabel: "브랜드A", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 1_000_000, dueDate: "2026-10-20" },
      { direction: "ISSUE", issuerLabel: "우리상사", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 450_000, dueDate: "2026-10-20" },
    ]);
  });

  it("12월 정산의 대금이 다음 해 1월이면 지급일 연도를 넘긴다", () => {
    const text = CLOSING_TABLE.replaceAll("9월", "12월").replace("550,000 10월 20일(화)", "550,000 1월 20일(화)");
    const parsed = parseSettlementStatement({ subject: "26년 12월 마감정산서", text, ourName: OURS });
    expect(parsed?.invoices.map((i) => [i.writtenDate, i.dueDate])).toEqual([
      ["2026-12-31", "2027-01-20"],
      ["2026-12-31", "2027-01-20"],
    ]);
  });

  it("연·월 머리글이 없으면 고르지 않는다(작성일을 지어내지 않는다)", () => {
    const text = CLOSING_TABLE.replace("26년 9월 마감정산서", "마감정산서").replace("26년 9월 가나다", "가나다");
    expect(parseSettlementStatement({ subject: "마감정산서 검토 요청", text, ourName: OURS })).toBeNull();
  });
});

describe("parseSettlementStatement — 자사몰 정산내역서(평문)", () => {
  it("이월분 블록마다 계산서 한 장 — 작성일·금액·지급일을 블록에서 읽는다", () => {
    const parsed = parseSettlementStatement({
      subject: "[우리상사_라마바]브랜드A 자사몰 공구 정산내역서 송부의 건 (20260827~20260902)",
      text: OWN_MALL_TWO_BLOCKS,
      ourName: OURS,
    });
    expect(parsed?.format).toBe("OWN_MALL_NOTICE");
    expect(parsed?.promotionLabel).toBe("우리상사_라마바");
    expect(parsed?.invoices).toEqual([
      { direction: "ISSUE", issuerLabel: "우리상사", writtenDate: "2026-08-31", yearMonth: "2026-08", totalAmount: 1_203_150, dueDate: "2026-09-18" },
      { direction: "ISSUE", issuerLabel: "우리상사", writtenDate: "2026-09-03", yearMonth: "2026-09", totalAmount: 805_200, dueDate: "2026-09-18" },
    ]);
  });

  it("셀러가 브랜드에 직접 발행하는 정산서는 우리 계산서가 아니다(direction null)", () => {
    const text = OWN_MALL_TWO_BLOCKS.replaceAll("우리상사 →", "라마바 →").replaceAll("→ 우리상사", "→ 라마바");
    const parsed = parseSettlementStatement({ subject: "[라마바] 정산내역서", text, ourName: OURS });
    expect(parsed?.invoices.map((i) => i.direction)).toEqual([null, null]);
  });

  it("브랜드가 우리에게 발행하면 RECEIVE", () => {
    const text = OWN_MALL_TWO_BLOCKS.replaceAll("우리상사 → 브랜드A 세금계산서", "브랜드A → 우리상사 세금계산서");
    const parsed = parseSettlementStatement({ subject: "[x] 정산내역서", text, ourName: OURS });
    expect(parsed?.invoices.map((i) => i.direction)).toEqual(["RECEIVE", "RECEIVE"]);
  });

  it("금액을 못 읽은 블록은 버린다 — 0원·빈 칸을 기대치로 만들지 않는다", () => {
    const text = OWN_MALL_TWO_BLOCKS.replace("1,203,150 원", "원");
    const parsed = parseSettlementStatement({ subject: "[x] 정산내역서", text, ourName: OURS });
    expect(parsed?.invoices.map((i) => i.totalAmount)).toEqual([805_200]);
  });
});

describe("형식 밖", () => {
  it("공구 확정 안내 같은 다른 메일은 null", () => {
    expect(parseSettlementStatement({ subject: "공구 확정 안내", text: "1. 공구 기간 ...", ourName: OURS })).toBeNull();
  });

  it("제목 거름망 — 정산서·정산내역서만", () => {
    expect(isSettlementStatementSubject("[브랜드A] 26년 9월 마감정산서 검토 요청")).toBe(true);
    expect(isSettlementStatementSubject("자사몰 공구 정산내역서 송부의 건")).toBe(true);
    expect(isSettlementStatementSubject("공구 확정 안내")).toBe(false);
  });
});
