import { describe, expect, it } from "vitest";
import { EMPTY_ETAX_PARTY_DETAIL, type EtaxPartyDetail, type ParsedEtaxInvoice } from "./etax-xml";
import { findPartnerInvoiceInfo, normalizePartnerName, type LookupMail } from "./partner-invoice-lookup";

// 값은 전부 가짜다(P0 — 이 레포는 public).
const OURS = "9998887777";
const VENDOR = "1112233333";
const OTHER = "4445566666";

function invoice(overrides: Partial<ParsedEtaxInvoice>): ParsedEtaxInvoice {
  return {
    issueId: "A1",
    typeCode: "0101",
    purposeCode: null,
    writtenDate: "2026-09-30",
    invoicerBusinessNumber: VENDOR,
    invoicerName: "(주)테스트공급",
    invoiceeBusinessNumber: OURS,
    invoiceeName: "우리회사",
    invoicerDetail: EMPTY_ETAX_PARTY_DETAIL,
    invoiceeDetail: EMPTY_ETAX_PARTY_DETAIL,
    amounts: { supplyAmount: 1000, taxAmount: 100, totalAmount: 1100 },
    lineItems: [],
    declaredEncoding: "UTF-8",
    ...overrides,
  };
}

function mail(parsed: ParsedEtaxInvoice | null, receivedAt = "2026-10-01T00:00:00.000Z"): LookupMail {
  return { parsed, receivedAt };
}

function detail(overrides: Partial<EtaxPartyDetail>): EtaxPartyDetail {
  return { ...EMPTY_ETAX_PARTY_DETAIL, ...overrides };
}

describe("findPartnerInvoiceInfo", () => {
  it("기안에 사업자번호가 있으면 그 번호의 계산서에서 공급자 정보를 모은다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [
        mail(invoice({ invoicerDetail: detail({ ceoName: "공급대표", address: "서울 가상로 1", businessType: "도소매", businessItem: "화장품", email: "vendor-tax@example.com" }) })),
      ],
      ourBusinessNumber: OURS,
      target: { name: "전혀 다른 상호", businessNumber: "111-22-33333" },
    });
    expect(result).toEqual({
      status: "FOUND",
      matchedBy: "BUSINESS_NUMBER",
      counterpart: { businessNumber: VENDOR, name: "(주)테스트공급" },
      values: {
        businessNumber: VENDOR,
        ceoName: "공급대표",
        businessType: "도소매",
        businessItem: "화장품",
        address: "서울 가상로 1",
        representativeEmail: "vendor-tax@example.com",
      },
      invoiceCount: 1,
      latestWrittenDate: "2026-09-30",
    });
  });

  it("사업자번호가 있으면 상호가 같아도 번호가 다른 계산서는 쓰지 않는다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [mail(invoice({ invoicerBusinessNumber: OTHER, invoicerName: "테스트공급" }))],
      ourBusinessNumber: OURS,
      target: { name: "테스트공급", businessNumber: VENDOR },
    });
    expect(result).toEqual({ status: "NOT_FOUND" });
  });

  it("우리가 발행한 계산서면 공급받는자가 거래 상대다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [
        mail(
          invoice({
            invoicerBusinessNumber: OURS,
            invoicerName: "우리회사",
            invoicerDetail: detail({ ceoName: "우리대표" }),
            invoiceeBusinessNumber: VENDOR,
            invoiceeName: "테스트브랜드",
            invoiceeDetail: detail({ ceoName: "브랜드대표", email: "brand-buyer@example.com" }),
          }),
        ),
      ],
      ourBusinessNumber: OURS,
      target: { name: "테스트브랜드", businessNumber: null },
    });
    expect(result.status).toBe("FOUND");
    if (result.status !== "FOUND") return;
    expect(result.values).toEqual({
      businessNumber: VENDOR,
      ceoName: "브랜드대표",
      representativeEmail: "brand-buyer@example.com",
    });
  });

  it("우리가 당사자가 아닌 계산서는 버린다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [mail(invoice({ invoiceeBusinessNumber: OTHER }))],
      ourBusinessNumber: OURS,
      target: { name: "테스트공급", businessNumber: VENDOR },
    });
    expect(result).toEqual({ status: "NOT_FOUND" });
  });

  it("상호는 법인 표기·공백만 걷고 완전히 같을 때만 맞춘다(포함 관계는 아니다)", () => {
    const mails = [mail(invoice({ invoicerName: "주식회사 테스트 공급" }))];
    expect(
      findPartnerInvoiceInfo({ mails, ourBusinessNumber: OURS, target: { name: "(주)테스트공급", businessNumber: null } }).status,
    ).toBe("FOUND");
    expect(
      findPartnerInvoiceInfo({ mails, ourBusinessNumber: OURS, target: { name: "테스트", businessNumber: null } }).status,
    ).toBe("NOT_FOUND");
  });

  it("상호가 같은 사업자가 둘이면 고르지 않는다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [
        mail(invoice({ invoicerName: "테스트공급" })),
        mail(invoice({ invoicerBusinessNumber: OTHER, invoicerName: "테스트공급" })),
      ],
      ourBusinessNumber: OURS,
      target: { name: "테스트공급", businessNumber: null },
    });
    expect(result).toEqual({
      status: "AMBIGUOUS",
      candidates: [
        { businessNumber: VENDOR, name: "테스트공급" },
        { businessNumber: OTHER, name: "테스트공급" },
      ],
    });
  });

  it("칸마다 가장 최근 계산서 값을 쓰고, 그 계산서에 없는 칸만 이전 계산서로 채운다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [
        mail(invoice({ writtenDate: "2026-07-31", invoicerDetail: detail({ address: "옛 주소", ceoName: "옛대표", businessItem: "화장품" }) })),
        mail(invoice({ writtenDate: "2026-09-30", invoicerDetail: detail({ address: "새 주소", ceoName: "새대표" }) })),
      ],
      ourBusinessNumber: OURS,
      target: { name: "무관", businessNumber: VENDOR },
    });
    expect(result.status).toBe("FOUND");
    if (result.status !== "FOUND") return;
    expect(result.values).toMatchObject({ address: "새 주소", ceoName: "새대표", businessItem: "화장품" });
    expect(result.invoiceCount).toBe(2);
    expect(result.latestWrittenDate).toBe("2026-09-30");
  });

  it("첨부를 못 읽은 메일(parsed null)은 건너뛴다", () => {
    const result = findPartnerInvoiceInfo({
      mails: [mail(null)],
      ourBusinessNumber: OURS,
      target: { name: "테스트공급", businessNumber: null },
    });
    expect(result).toEqual({ status: "NOT_FOUND" });
  });
});

describe("normalizePartnerName", () => {
  it("법인 표기·괄호·공백·대소문자를 걷어낸다", () => {
    expect(normalizePartnerName("㈜ Test 공급")).toBe(normalizePartnerName("주식회사 test공급"));
  });
});
