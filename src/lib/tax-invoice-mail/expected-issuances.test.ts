import { describe, it, expect } from "vitest";
import {
  buildGroupExpectedIssuances,
  type CampaignIssuanceFacts,
} from "./expected-issuances";

/**
 * 발행 기대 건 생성의 계약.
 *
 * ⚠️ 이 스위트의 존재 이유는 **자동 확정이 그룹 전체를 잘못 찍는 것**을 막는 데 있다.
 * 그래서 「후퇴하면 writeTarget 이 null」 계열 검사는 지우거나 완화하지 말 것 —
 * 그 값이 비면 크론이 그룹 필드를 찍고, 그룹 필드는 멤버 전원이 공유한다.
 */

function facts(over: Partial<CampaignIssuanceFacts> = {}): CampaignIssuanceFacts {
  return {
    campaignId: "c1",
    campaignLabel: "1회차 캠페인",
    salesChannel: "BRAND_MALL",
    actualSales: 1_100_000,
    settlementSales: 330_000,
    sellerExpense: 220_000,
    sellerBusinessNumber: "1112233333",
    sellerTaxType: "BUSINESS",
    sellerLabel: "셀러사",
    partnerBusinessNumber: "2223344444",
    partnerLabel: "거래처",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    validWrittenDateFrom: "2026-07-01",
    validWrittenDateTo: "2026-10-01",
    groupId: null,
    ...over,
  };
}

describe("buildGroupExpectedIssuances — 채널별 발행 의무", () => {
  it("브랜드몰은 공급사 앞 발행 1건을 낸다(금액 = 영업수익)", () => {
    const [item, ...rest] = buildGroupExpectedIssuances([facts()]);
    expect(rest).toHaveLength(0);
    expect(item.counterpart).toBe("SUPPLIER");
    expect(item.counterpartBusinessNumber).toBe("2223344444");
    expect(item.expectedTotalAmount).toBe(330_000);
    expect(item.trackingField).toBe("supplierInvoiceIssuedAt");
    expect(item.writeTarget).toEqual({ kind: "campaign", campaignId: "c1" });
  });

  it("셀러몰은 셀러 앞 발행 1건을 낸다(금액 = 매출 − 셀러수수료)", () => {
    const [item] = buildGroupExpectedIssuances([facts({ salesChannel: "SELLER_MALL" })]);
    expect(item.counterpart).toBe("SELLER");
    expect(item.counterpartBusinessNumber).toBe("1112233333");
    expect(item.expectedTotalAmount).toBe(1_100_000 - 220_000);
  });

  // ── 음성 대조군: 우리몰은 두 의무가 **둘 다 수취**라 발행 기대 건이 하나도 없어야 한다.
  //    이게 깨지면 수취해야 할 건을 우리가 발행한 것으로 찍는다.
  it("우리몰은 발행 기대 건을 만들지 않는다", () => {
    expect(buildGroupExpectedIssuances([facts({ salesChannel: "OWN_MALL" })])).toEqual([]);
    expect(buildGroupExpectedIssuances([facts({ salesChannel: "OWN_MALL_NAVER" })])).toEqual([]);
  });

  it("금액 근거가 결번이면 기대 금액을 0 이 아니라 null(모름)로 둔다", () => {
    const [item] = buildGroupExpectedIssuances([facts({ settlementSales: null })]);
    expect(item.expectedTotalAmount).toBeNull();
    expect(item.amountBlockingReasons.length).toBeGreaterThan(0);
  });
});

describe("buildGroupExpectedIssuances — 정산 그룹", () => {
  const groupMembers = [
    facts({ campaignId: "c1", groupId: "g1", settlementSales: 330_000 }),
    facts({ campaignId: "c2", groupId: "g1", settlementSales: 220_000 }),
  ];

  it("채널·상대가 같으면 그룹 1건으로 합산하고 그룹 행에 쓴다", () => {
    const result = buildGroupExpectedIssuances(groupMembers);
    expect(result).toHaveLength(1);
    expect(result[0].expectedTotalAmount).toBe(550_000);
    expect(result[0].campaignIds).toEqual(["c1", "c2"]);
    expect(result[0].writeTarget).toEqual({ kind: "group", groupId: "g1" });
  });

  it("멤버가 1건인 그룹도 캠페인 행이 아니라 그룹 행에 쓴다", () => {
    const [item] = buildGroupExpectedIssuances([facts({ campaignId: "c9", groupId: "g9" })]);
    expect(item.writeTarget).toEqual({ kind: "group", groupId: "g9" });
  });

  // ── 이 트랙의 가장 비싼 실패를 막는 검사 3종. 전부 `writeTarget === null` 이어야 한다.
  it("공급사가 갈리면 캠페인별로 후퇴하고 **자동 확정 대상에서 뺀다**", () => {
    const result = buildGroupExpectedIssuances([
      groupMembers[0],
      facts({ campaignId: "c2", groupId: "g1", partnerBusinessNumber: "9998877777" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.writeTarget)).toEqual([null, null]);
  });

  it("채널이 갈리면 캠페인별로 후퇴하고 자동 확정 대상에서 뺀다", () => {
    const result = buildGroupExpectedIssuances([
      groupMembers[0],
      facts({ campaignId: "c2", groupId: "g1", salesChannel: "SELLER_MALL" }),
    ]);
    expect(result.every((r) => r.writeTarget === null)).toBe(true);
  });

  it("groupId 가 섞인 묶음이 들어오면 조용히 하나를 고르지 않고 후퇴한다", () => {
    const result = buildGroupExpectedIssuances([
      groupMembers[0],
      facts({ campaignId: "c2", groupId: "g2" }),
    ]);
    expect(result.every((r) => r.writeTarget === null)).toBe(true);
  });

  it("합산은 누락을 0 으로 치지 않는다 — 멤버 하나가 비면 전체가 모름", () => {
    const result = buildGroupExpectedIssuances([
      groupMembers[0],
      facts({ campaignId: "c2", groupId: "g1", settlementSales: null }),
    ]);
    expect(result[0].expectedTotalAmount).toBeNull();
  });

  /**
   * 교차 검증(2026-08-06)에서 나온 회귀 방지.
   *
   * 조회 창이 그룹 멤버를 잘라 **부분집합**만 넘어오면, 이 함수는 잘린 집합만 보고
   * "공급사 동일"로 판단해 그룹 필드에 쓰는 계획을 낸다 — 창 밖 멤버의 발행 의무가
   * 미이행인 채로 보드에서 사라진다. 함수 자체는 넘겨받은 것만 볼 수 있으므로 **절단을
   * 막는 책임은 `campaign-facts.ts` 에 있다**(그래서 그쪽이 groupId 로 멤버를 다시 읽는다).
   * 이 테스트는 그 계약이 왜 필요한지를 코드로 고정한다 — 부분집합을 주면 실제로
   * 그룹 쓰기가 나온다는 것을 보여 준다.
   */
  it("⚠️ 부분집합만 주면 그룹 쓰기가 나온다 — 절단 방지는 campaign-facts 의 책임이다", () => {
    const truncated = buildGroupExpectedIssuances([groupMembers[0]]);
    expect(truncated[0].writeTarget).toEqual({ kind: "group", groupId: "g1" });
    // 전원을 주면 공급사가 갈리므로 자동 확정 대상에서 빠진다 — 같은 그룹인데 결과가
    // 정반대다. 이 간극이 조회 창 절단의 위험 그 자체다.
    const full = buildGroupExpectedIssuances([
      groupMembers[0],
      facts({ campaignId: "c2", groupId: "g1", partnerBusinessNumber: "9998877777" }),
    ]);
    expect(full.every((r) => r.writeTarget === null)).toBe(true);
  });

  it("작성일자 타당 창은 멤버 전원을 아우른다(좁히면 정상 건이 확인필요로 떨어진다)", () => {
    const result = buildGroupExpectedIssuances([
      facts({ campaignId: "c1", groupId: "g1", validWrittenDateFrom: "2026-07-01", validWrittenDateTo: "2026-09-01" }),
      facts({ campaignId: "c2", groupId: "g1", validWrittenDateFrom: "2026-06-01", validWrittenDateTo: "2026-10-01" }),
    ]);
    expect(result[0].validWrittenDateFrom).toBe("2026-06-01");
    expect(result[0].validWrittenDateTo).toBe("2026-10-01");
  });
});
