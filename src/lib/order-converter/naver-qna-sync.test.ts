import { describe, it, expect } from "vitest";
import {
  parseProductQna,
  parseCustomerInquiry,
  splitProductOrderIds,
  resolveMostRecentDealByProduct,
  extendDealMapWithChannelNumbers,
  parseProductNumberPairs,
  type ProductDealRow,
} from "./naver-qna-sync";

describe("parseProductQna", () => {
  it("정상 상품문의 element를 upsert 데이터로 변환한다", () => {
    const out = parseProductQna({
      questionId: 12345,
      productId: 987654,
      productName: "테스트 상품",
      question: "배송 언제 되나요",
      answer: "내일 발송됩니다",
      answered: true,
      maskedWriterId: "ab***",
      createDate: "2026-07-15T10:00:00.000+09:00",
    });
    expect(out).toMatchObject({
      questionId: "12345",
      productId: "987654",
      productName: "테스트 상품",
      question: "배송 언제 되나요",
      answer: "내일 발송됩니다",
      answered: true,
      writerMasked: "ab***",
    });
    expect(out?.createDate).toBeInstanceOf(Date);
    expect(Number.isNaN(out!.createDate.getTime())).toBe(false);
  });

  it("int64 식별자를 String으로 보관한다(정밀도 손실 방지)", () => {
    const out = parseProductQna({
      questionId: "900000000000000123",
      productId: "13583224998",
      question: "q",
      createDate: "2026-07-15T00:00:00.000Z",
    });
    expect(out?.questionId).toBe("900000000000000123");
    expect(out?.productId).toBe("13583224998");
  });

  it("questionId·productId·createDate 결측이면 null(스킵)", () => {
    expect(parseProductQna({ productId: "1", createDate: "2026-07-15T00:00:00Z" })).toBeNull();
    expect(parseProductQna({ questionId: "1", createDate: "2026-07-15T00:00:00Z" })).toBeNull();
    expect(parseProductQna({ questionId: "1", productId: "1" })).toBeNull();
    expect(parseProductQna({ questionId: "1", productId: "1", createDate: "not-a-date" })).toBeNull();
  });

  it("미답변 문의는 answered=false·answer=null", () => {
    const out = parseProductQna({
      questionId: "7",
      productId: "8",
      question: "질문",
      answered: false,
      createDate: "2026-07-16T00:00:00Z",
    });
    expect(out?.answered).toBe(false);
    expect(out?.answer).toBeNull();
  });
});

describe("parseCustomerInquiry", () => {
  it("정상 고객문의를 변환하고 PII(customerId/customerName)를 버린다", () => {
    const out = parseCustomerInquiry({
      inquiryNo: 55501,
      category: "배송",
      title: "언제 오나요",
      inquiryContent: "주문한 상품 배송 문의",
      answered: true,
      answerRegistrationDateTime: "2026-07-16T09:00:00.000+09:00",
      inquiryRegistrationDateTime: "2026-07-15T09:00:00.000+09:00",
      orderId: "2026071512345",
      productNo: "13583224998",
      productOrderIdList: "111,222,333",
      productOrderOption: "블랙 / L",
      customerId: "SHOULD_NOT_PERSIST",
      customerName: "홍길동",
    });
    expect(out).toMatchObject({
      inquiryNo: "55501",
      category: "배송",
      title: "언제 오나요",
      content: "주문한 상품 배송 문의",
      answered: true,
      orderId: "2026071512345",
      productNo: "13583224998",
      productOrderIds: "111,222,333",
      optionText: "블랙 / L",
    });
    // PII 필드는 결과 객체에 존재하지 않아야 한다(계획서 D4).
    expect(out as Record<string, unknown>).not.toHaveProperty("customerId");
    expect(out as Record<string, unknown>).not.toHaveProperty("customerName");
    expect(out?.answerAt).toBeInstanceOf(Date);
  });

  it("미답변 문의는 answerAt=null", () => {
    const out = parseCustomerInquiry({
      inquiryNo: "9",
      category: "상품",
      title: "t",
      inquiryContent: "c",
      answered: false,
      inquiryRegistrationDateTime: "2026-07-15T00:00:00Z",
      orderId: "o1",
      productOrderIdList: "1",
    });
    expect(out?.answered).toBe(false);
    expect(out?.answerAt).toBeNull();
  });

  it("inquiryNo·등록일시 결측이면 null(스킵)", () => {
    expect(
      parseCustomerInquiry({ category: "상품", inquiryRegistrationDateTime: "2026-07-15T00:00:00Z" }),
    ).toBeNull();
    expect(parseCustomerInquiry({ inquiryNo: "1", category: "상품" })).toBeNull();
  });
});

describe("resolveMostRecentDealByProduct", () => {
  const row = (productId: string | null, dealId: string, createdAt: string): ProductDealRow => ({
    productId,
    salesCampaigns: [{ dealId, createdAt: new Date(createdAt) }],
  });

  it("productId → 최신 캠페인의 dealId를 택한다(회차 여럿)", () => {
    // 같은 상품(원상품번호 999)이 과거 종료 회차(deal-old)와 현재 회차(deal-new)에 걸침.
    const rows = [
      row("999", "deal-old", "2026-01-01T00:00:00Z"),
      row("999", "deal-new", "2026-07-01T00:00:00Z"),
    ];
    const map = resolveMostRecentDealByProduct(rows);
    expect(map.get("999")).toBe("deal-new"); // 무정렬 순서와 무관하게 최신 고정
  });

  it("입력 순서가 뒤집혀도 최신이 이긴다(first-write-wins 회귀 방지)", () => {
    const rows = [
      row("999", "deal-new", "2026-07-01T00:00:00Z"), // 최신이 먼저 와도
      row("999", "deal-old", "2026-01-01T00:00:00Z"), // 과거가 덮지 않음
    ];
    expect(resolveMostRecentDealByProduct(rows).get("999")).toBe("deal-new");
  });

  it("서로 다른 상품은 각자 매핑된다", () => {
    const rows = [row("111", "deal-a", "2026-05-01T00:00:00Z"), row("222", "deal-b", "2026-05-02T00:00:00Z")];
    const map = resolveMostRecentDealByProduct(rows);
    expect(map.get("111")).toBe("deal-a");
    expect(map.get("222")).toBe("deal-b");
  });

  it("productId null·salesCampaign 없음·빈 productId는 건너뛴다", () => {
    const rows: ProductDealRow[] = [
      { productId: null, salesCampaigns: [{ dealId: "x", createdAt: new Date("2026-01-01") }] },
      { productId: "  ", salesCampaigns: [{ dealId: "y", createdAt: new Date("2026-01-01") }] },
      { productId: "333", salesCampaigns: [] },
    ];
    expect(resolveMostRecentDealByProduct(rows).size).toBe(0);
  });

  it("productId는 trim되어 키가 된다", () => {
    expect(resolveMostRecentDealByProduct([row(" 444 ", "deal-c", "2026-05-01T00:00:00Z")]).get("444")).toBe("deal-c");
  });
});

describe("extendDealMapWithChannelNumbers", () => {
  it("원상품번호가 맵에 있으면 그 딜로 채널번호들을 추가한다(31일 백필 0/19 매칭 보강)", () => {
    const map = new Map([["1000", "deal-a"]]);
    const added = extendDealMapWithChannelNumbers(map, [
      { originProductNo: "1000", channelProductNos: ["2000", "2001"] },
    ]);
    expect(added).toBe(2);
    expect(map.get("2000")).toBe("deal-a"); // 채널번호로 온 문의도 같은 딜
    expect(map.get("2001")).toBe("deal-a");
    expect(map.get("1000")).toBe("deal-a"); // 원 키 보존
  });

  it("맵에 없는 원상품(캠페인 아닌 스토어 상품)은 무시한다", () => {
    const map = new Map([["1000", "deal-a"]]);
    const added = extendDealMapWithChannelNumbers(map, [
      { originProductNo: "9999", channelProductNos: ["8888"] },
    ]);
    expect(added).toBe(0);
    expect(map.has("8888")).toBe(false);
  });

  it("기존 키는 덮지 않는다(채널번호가 다른 딜의 원상품번호와 충돌해도 원상품 우선)", () => {
    const map = new Map([["1000", "deal-a"], ["2000", "deal-b"]]);
    const added = extendDealMapWithChannelNumbers(map, [
      { originProductNo: "1000", channelProductNos: ["2000"] },
    ]);
    expect(added).toBe(0);
    expect(map.get("2000")).toBe("deal-b");
  });
});

describe("parseProductNumberPairs", () => {
  it("products/search contents에서 원·채널 번호 쌍을 추출한다(campaigns-handler 응답 형태)", () => {
    const pairs = parseProductNumberPairs([
      { originProductNo: 1000, channelProducts: [{ channelProductNo: 2000, name: "테스트 상품" }, { channelProductNo: "2001" }] },
      { originProductNo: "1001", channelProducts: [] },
      { channelProducts: [{ channelProductNo: 3000 }] }, // origin 없음 — 스킵
    ]);
    expect(pairs).toEqual([
      { originProductNo: "1000", channelProductNos: ["2000", "2001"], name: "테스트 상품" }, // Tier-2용 리스팅명
      { originProductNo: "1001", channelProductNos: [], name: "" },
    ]);
  });

  it("배열 아님·결측은 빈 배열", () => {
    expect(parseProductNumberPairs(null as never)).toEqual([]);
    expect(parseProductNumberPairs([{ originProductNo: "1", channelProducts: null }])).toEqual([
      { originProductNo: "1", channelProductNos: [], name: "" },
    ]);
  });
});

describe("splitProductOrderIds", () => {
  it("콤마 문자열을 정규화 배열로 분해한다", () => {
    expect(splitProductOrderIds("111,222,333")).toEqual(["111", "222", "333"]);
  });
  it("공백·빈 세그먼트를 제거한다", () => {
    expect(splitProductOrderIds(" 111 , , 222 ,")).toEqual(["111", "222"]);
  });
  it("null·빈 문자열은 빈 배열", () => {
    expect(splitProductOrderIds(null)).toEqual([]);
    expect(splitProductOrderIds("")).toEqual([]);
    expect(splitProductOrderIds(undefined)).toEqual([]);
  });
});
