import { describe, it, expect } from "vitest";
import {
  parseEtaxInvoiceXml,
  normalizeEtaxBusinessNumber,
  normalizeEtaxDate,
} from "./etax-xml";

/**
 * 픽스처는 국세청 표준 샘플의 **구조**만 따르고 값은 전부 가짜다(P0 — 이 레포는 public).
 * 사업자등록번호도 실재하지 않는 자리수만 맞춘 값이다.
 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<TaxInvoice xmlns="urn:kr:or:kec:standard:Tax:ReusableAggregateBusinessInformationEntitySchemaModule:1:0">
  <ExchangedDocument>
    <ID>DOCNO-0001</ID>
    <IssueDateTime>20260803220351</IssueDateTime>
  </ExchangedDocument>
  <TaxInvoiceDocument>
    <IssueID>202608031234567890123456</IssueID>
    <TypeCode>0101</TypeCode>
    <IssueDateTime>20260731</IssueDateTime>
    <PurposeCode>02</PurposeCode>
  </TaxInvoiceDocument>
  <TaxInvoiceTradeSettlement>
    <InvoicerParty>
      <ID>1112233333</ID>
      <NameText>테스트공급사</NameText>
    </InvoicerParty>
    <InvoiceeParty>
      <ID>2223344444</ID>
      <NameText>테스트수취사</NameText>
    </InvoiceeParty>
    <SpecifiedMonetarySummation>
      <ChargeTotalAmount>1000000</ChargeTotalAmount>
      <TaxTotalAmount>100000</TaxTotalAmount>
      <GrandTotalAmount>1100000</GrandTotalAmount>
    </SpecifiedMonetarySummation>
  </TaxInvoiceTradeSettlement>
</TaxInvoice>`;

/**
 * 품목 줄이 있는 표본. 경로는 실계산서에서 실측했다(2026-08-05) — `TaxInvoiceTradeLineItem`
 * 은 `TaxInvoice` **바로 아래** 반복 형제이고, 상호·대표자명이 쓰는 `NameText` 와 태그명이
 * 같다. 그래서 아래 표본은 **양쪽에 다 `NameText` 를 두어** 스코프 혼동을 잡는다.
 */
const SAMPLE_WITH_ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<TaxInvoice xmlns="urn:kr:or:kec:standard:Tax:ReusableAggregateBusinessInformationEntitySchemaModule:1:0">
  <TaxInvoiceDocument>
    <IssueID>202608031234567890123456</IssueID>
    <TypeCode>0101</TypeCode>
    <IssueDateTime>20260731</IssueDateTime>
  </TaxInvoiceDocument>
  <TaxInvoiceTradeSettlement>
    <InvoicerParty>
      <ID>1112233333</ID>
      <NameText>테스트공급사</NameText>
      <SpecifiedPerson><NameText>테스트대표</NameText></SpecifiedPerson>
    </InvoicerParty>
    <InvoiceeParty><ID>2223344444</ID><NameText>테스트수취사</NameText></InvoiceeParty>
    <SpecifiedMonetarySummation>
      <ChargeTotalAmount>2396450</ChargeTotalAmount>
      <TaxTotalAmount>239645</TaxTotalAmount>
      <GrandTotalAmount>2636095</GrandTotalAmount>
    </SpecifiedMonetarySummation>
  </TaxInvoiceTradeSettlement>
  <TaxInvoiceTradeLineItem>
    <SequenceNumeric>1</SequenceNumeric>
    <NameText>테스트딜 공동구매 1차</NameText>
    <ChargeableUnitQuantity>1</ChargeableUnitQuantity>
    <UnitPrice><UnitAmount>396450</UnitAmount></UnitPrice>
    <InvoiceAmount>396450</InvoiceAmount>
    <TotalTax><CalculatedAmount>39645</CalculatedAmount></TotalTax>
  </TaxInvoiceTradeLineItem>
  <TaxInvoiceTradeLineItem>
    <SequenceNumeric>2</SequenceNumeric>
    <NameText>광고비</NameText>
    <InvoiceAmount>2000000</InvoiceAmount>
    <TotalTax><CalculatedAmount>200000</CalculatedAmount></TotalTax>
  </TaxInvoiceTradeLineItem>
</TaxInvoice>`;

describe("품목 줄 파싱", () => {
  it("품목을 순서대로 뽑는다(수량·단가·공급가액·세액 포함)", () => {
    const parsed = parseEtaxInvoiceXml(SAMPLE_WITH_ITEMS);
    expect(parsed?.lineItems).toHaveLength(2);
    expect(parsed?.lineItems[0]).toEqual({
      sequence: 1,
      name: "테스트딜 공동구매 1차",
      quantity: 1,
      unitPrice: 396450,
      supplyAmount: 396450,
      taxAmount: 39645,
    });
  });

  /**
   * ⛔ 이 계열의 핵심 함정 — 정규식으로 `NameText` 를 훑으면 **공급자 상호와 대표자명이
   * 품목명으로 섞여 들어온다.** 경로 한정이 실제로 걸려 있는지 여기서 고정한다.
   */
  it("상호·대표자명을 품목명으로 집지 않는다", () => {
    const names = parseEtaxInvoiceXml(SAMPLE_WITH_ITEMS)?.lineItems.map((i) => i.name);
    expect(names).toEqual(["테스트딜 공동구매 1차", "광고비"]);
    expect(names).not.toContain("테스트공급사");
    expect(names).not.toContain("테스트대표");
    expect(names).not.toContain("테스트수취사");
  });

  it("품목 줄이 없으면 빈 배열이다(null 이 아니다)", () => {
    expect(parseEtaxInvoiceXml(SAMPLE)?.lineItems).toEqual([]);
  });

  it("없는 값은 0 이 아니라 null 이다", () => {
    const second = parseEtaxInvoiceXml(SAMPLE_WITH_ITEMS)?.lineItems[1];
    expect(second?.quantity).toBeNull();
    expect(second?.unitPrice).toBeNull();
  });

  it("인코딩을 못 믿으면 품목명도 비운다(상호와 같은 규칙)", () => {
    const euckr = SAMPLE_WITH_ITEMS.replace('encoding="UTF-8"', 'encoding="EUC-KR"');
    const parsed = parseEtaxInvoiceXml(euckr);
    expect(parsed?.lineItems.map((i) => i.name)).toEqual([null, null]);
    // 숫자는 ASCII 라 온전해야 한다 — 이름만 비우고 파싱을 멈추지 않는다.
    expect(parsed?.lineItems[1].supplyAmount).toBe(2000000);
  });
});

describe("parseEtaxInvoiceXml — 표준 스키마 추출", () => {
  it("작성일자·승인번호·양측 사업자번호·금액 3종을 뽑는다", () => {
    const parsed = parseEtaxInvoiceXml(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed?.issueId).toBe("202608031234567890123456");
    expect(parsed?.typeCode).toBe("0101");
    expect(parsed?.purposeCode).toBe("02");
    expect(parsed?.invoicerBusinessNumber).toBe("1112233333");
    expect(parsed?.invoiceeBusinessNumber).toBe("2223344444");
    expect(parsed?.amounts).toEqual({
      supplyAmount: 1000000,
      taxAmount: 100000,
      totalAmount: 1100000,
    });
  });

  /**
   * ⛔ 이 테스트가 이 파일의 존재 이유다.
   * `IssueDateTime` 은 ExchangedDocument(전송일시 14자리)에도 있어서, 정규식 첫 매치로 뽑으면
   * 작성일자(20260731) 대신 전송일(20260803)을 읽는다. 오너가 확인하려는 필드가 바로 이것이다.
   */
  it("작성일자로 ExchangedDocument 의 전송일시를 집지 않는다", () => {
    const parsed = parseEtaxInvoiceXml(SAMPLE);
    expect(parsed?.writtenDate).toBe("2026-07-31");
    expect(parsed?.writtenDate).not.toBe("2026-08-03");
  });

  /** `ID` 는 세 스코프에 있다 — 문서번호를 사업자번호로 오독하면 수취 판정이 통째로 무너진다. */
  it("ExchangedDocument/ID(문서번호)를 사업자번호로 집지 않는다", () => {
    const parsed = parseEtaxInvoiceXml(SAMPLE);
    expect(parsed?.invoicerBusinessNumber).not.toBe("DOCNO-0001");
    expect(parsed?.invoiceeBusinessNumber).not.toBe("DOCNO-0001");
  });

  it("공급자와 공급받는자를 뒤집지 않는다", () => {
    const parsed = parseEtaxInvoiceXml(SAMPLE);
    expect(parsed?.invoicerName).toBe("테스트공급사");
    expect(parsed?.invoiceeName).toBe("테스트수취사");
  });

  it("네임스페이스 접두사가 붙어도 읽는다", () => {
    const prefixed = SAMPLE.replace(/<(\/?)(TaxInvoice|TaxInvoiceDocument|TaxInvoiceTradeSettlement|InvoiceeParty|ID)([\s>])/g, "<$1ns2:$2$3");
    const parsed = parseEtaxInvoiceXml(prefixed);
    expect(parsed?.invoiceeBusinessNumber).toBe("2223344444");
    expect(parsed?.writtenDate).toBe("2026-07-31");
  });

  it("계산서가 아닌 XML 은 null 을 돌려준다(억지 해석 금지)", () => {
    expect(parseEtaxInvoiceXml("<PurchaseOrder><ID>1</ID></PurchaseOrder>")).toBeNull();
  });

  it("UTF-8 이 아닌 선언이면 이름 값을 신뢰하지 않고 비운다(숫자는 유지)", () => {
    const euckr = SAMPLE.replace('encoding="UTF-8"', 'encoding="EUC-KR"');
    const parsed = parseEtaxInvoiceXml(euckr);
    expect(parsed?.declaredEncoding).toBe("EUC-KR");
    expect(parsed?.invoicerName).toBeNull();
    expect(parsed?.invoiceeBusinessNumber).toBe("2223344444");
    expect(parsed?.amounts.totalAmount).toBe(1100000);
  });

  it("문서가 중간에 잘려도 앞부분 값은 살린다", () => {
    const truncated = SAMPLE.slice(0, SAMPLE.indexOf("<SpecifiedMonetarySummation>"));
    const parsed = parseEtaxInvoiceXml(truncated);
    expect(parsed?.invoicerBusinessNumber).toBe("1112233333");
    expect(parsed?.amounts.totalAmount).toBeNull();
  });

  it("CDATA·엔티티·자기닫힘 태그를 처리한다", () => {
    const odd = SAMPLE.replace(
      "<NameText>테스트공급사</NameText>",
      "<NameText><![CDATA[테스트 & 공급사]]></NameText><EmptyTag/>",
    ).replace("<NameText>테스트수취사</NameText>", "<NameText>수취 &amp; 사</NameText>");
    const parsed = parseEtaxInvoiceXml(odd);
    expect(parsed?.invoicerName).toBe("테스트 & 공급사");
    expect(parsed?.invoiceeName).toBe("수취 & 사");
  });
});

describe("정규화 헬퍼", () => {
  it("사업자번호는 10자리일 때만 통과시킨다", () => {
    expect(normalizeEtaxBusinessNumber("111-22-33333")).toBe("1112233333");
    expect(normalizeEtaxBusinessNumber("11122")).toBeNull();
    expect(normalizeEtaxBusinessNumber(null)).toBeNull();
  });

  it("작성일자는 8자리·14자리·하이픈 표기를 모두 받는다", () => {
    expect(normalizeEtaxDate("20260731")).toBe("2026-07-31");
    expect(normalizeEtaxDate("20260731235959")).toBe("2026-07-31");
    expect(normalizeEtaxDate("2026-07-31")).toBe("2026-07-31");
    expect(normalizeEtaxDate("20261331")).toBeNull();
    expect(normalizeEtaxDate("abc")).toBeNull();
  });
});
