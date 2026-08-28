import { describe, it, expect } from "vitest";
import {
  buildExpectedReceivables,
  buildGroupExpectedReceivables,
  resolveChannelKind,
  type CampaignSettlementFacts,
} from "./expected-receivables";

/** 값은 전부 가짜다(P0 — public 레포). */
function facts(overrides: Partial<CampaignSettlementFacts> = {}): CampaignSettlementFacts {
  return {
    campaignId: "camp1",
    campaignLabel: "캠페인",
    salesChannel: "BRAND_MALL",
    actualSales: 10_000_000,
    settlementSales: 5_000_000,
    sellerExpense: 2_000_000,
    sellerBusinessNumber: "1112233333",
    sellerLabel: "셀러",
    partnerBusinessNumber: "4445566666",
    partnerLabel: "공급사",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    ...overrides,
  };
}

describe("resolveChannelKind — campaign-checklist 와 같은 분기여야 한다", () => {
  it("OWN_MALL 접두사 전부를 우리몰로 접는다", () => {
    expect(resolveChannelKind("OWN_MALL")).toBe("OWN_MALL");
    expect(resolveChannelKind("OWN_MALL_NAVER")).toBe("OWN_MALL");
    expect(resolveChannelKind("OWN_MALL_KAKAO")).toBe("OWN_MALL");
  });

  it("BRAND_MALL 은 정확 일치", () => {
    expect(resolveChannelKind("BRAND_MALL")).toBe("BRAND_MALL");
  });

  it("UNSPECIFIED·null·미지값은 셀러몰로 떨어진다(기존 동작 보존)", () => {
    expect(resolveChannelKind("SELLER_MALL")).toBe("SELLER_MALL");
    expect(resolveChannelKind("UNSPECIFIED")).toBe("SELLER_MALL");
    expect(resolveChannelKind(null)).toBe("SELLER_MALL");
    expect(resolveChannelKind("SOMETHING_NEW")).toBe("SELLER_MALL");
  });
});

describe("buildExpectedReceivables — 채널별 수취 건", () => {
  it("우리몰: 공급사·셀러 둘 다 수취이고, 공급사 금액은 셀러몰과 같은 식(actualSales−settlementSales)으로 확정됐다", () => {
    // actualSales·settlementSales·차이값을 모두 다르게 잡는다 — 잘못된 식(예: settlementSales
    // 단독, actualSales 단독)을 썼다면 이 값들과 겹쳐 오답을 못 잡아낸다(오너 확정
    // 2026-08-04, "우리몰 공급사 물품대금 — 확정됨" 절).
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "OWN_MALL_NAVER", actualSales: 10_000_000, settlementSales: 3_000_000 }),
    );
    expect(rows.map((r) => r.slot)).toEqual(["SUPPLIER_GOODS", "SELLER_COMMISSION"]);

    const goods = rows[0];
    expect(goods.expectedTotalAmount).toBe(7_000_000); // 10,000,000 − 3,000,000
    expect(goods.expectedTotalAmount).not.toBe(3_000_000); // settlementSales 단독(오답)
    expect(goods.expectedTotalAmount).not.toBe(10_000_000); // actualSales 단독(오답)
    expect(goods.amountBasis).not.toContain("확인 필요");
    expect(goods.amountBasis).toContain("actualSales");
    expect(goods.amountBasis).toContain("settlementSales");
    expect(goods.counterpartBusinessNumber).toBe("4445566666");
    expect(goods.trackingField).toBe("supplierInvoiceIssuedAt");

    expect(rows[1].expectedTotalAmount).toBe(2_000_000);
  });

  it("우리몰: settlementSales 가 없으면(null) 기대 금액은 actualSales 로 대체되지 않고 null(모름)이다", () => {
    // 뺄셈에서 null 을 0 으로 치면 actualSales 전액이 그대로 나와 "그럴듯한 오답"이 된다
    // (SELLER_MALL 과 같은 함정 — expected-receivables.ts 주석 참조).
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "OWN_MALL", actualSales: 10_000_000, settlementSales: null }),
    );
    const goods = rows[0];
    expect(goods.expectedTotalAmount).toBeNull();
    expect(goods.expectedTotalAmount).not.toBe(10_000_000);
  });

  it("브랜드몰: 셀러 수수료 수취 1건뿐 — supplierInvoiceIssuedAt 은 발행이라 제외", () => {
    const rows = buildExpectedReceivables(facts({ salesChannel: "BRAND_MALL" }));
    expect(rows).toHaveLength(1);
    expect(rows[0].slot).toBe("SELLER_COMMISSION");
    expect(rows[0].expectedTotalAmount).toBe(2_000_000);
    expect(rows[0].trackingField).toBe("sellerInvoiceIssuedAt");
  });

  it("셀러몰: 공급사 물품비 수취 1건 = 총매출 − 영업수익", () => {
    const rows = buildExpectedReceivables(facts({ salesChannel: "SELLER_MALL" }));
    expect(rows).toHaveLength(1);
    expect(rows[0].slot).toBe("SUPPLIER_GOODS");
    expect(rows[0].expectedTotalAmount).toBe(5_000_000);
  });

  it("셀러몰 물품비 수취도 우리몰·브랜드몰과 같은 필드로 추적한다(2026-08-07)", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "SELLER_MALL", supplierInvoiceIssuedAt: "2026-07-31" }),
    );
    expect(rows[0].trackingField).toBe("supplierInvoiceIssuedAt");
    expect(rows[0].alreadyMarkedAt).toBe("2026-07-31");
  });

  it("금액 원천이 비면 기대 금액은 0 이 아니라 null(모름)", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "SELLER_MALL", settlementSales: null }),
    );
    expect(rows[0].expectedTotalAmount).toBeNull();
  });

  /**
   * ⛔ 종전 계약("개인 셀러면 상대 사업자번호가 null 인 기대 건을 만든다")은 **결함이었다.**
   * 그 기대 건은 대조 키가 없어 어떤 계산서와도 매칭되지 않으므로 「미수취」에 영구히
   * 남았고, 보드는 같은 규칙으로 그 행을 이미 빼고 있어 두 화면이 서로 다른 말을 했다.
   * 개인 셀러는 계산서가 아니라 원천징수 대상이다 — 기대 건 자체가 성립하지 않는다.
   */
  it("개인 셀러면 셀러 수수료 기대 건을 만들지 않는다", () => {
    expect(
      buildExpectedReceivables(facts({ salesChannel: "BRAND_MALL", sellerBusinessNumber: null })),
    ).toEqual([]);
    expect(
      buildExpectedReceivables(
        facts({ salesChannel: "BRAND_MALL", sellerTaxType: "INDIVIDUAL" }),
      ),
    ).toEqual([]);
  });

  it("우리몰에서도 셀러 몫만 빠지고 공급사 물품대금은 남는다", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL" }),
    );
    expect(rows.map((row) => row.slot)).toEqual(["SUPPLIER_GOODS"]);
  });

  /**
   * 반대쪽 경계 — **사업자 셀러인데 사업자번호만 미등록**인 경우는 기대 건을 만든다.
   * 계산서는 실제로 오지만 우리가 대조할 키가 없는 상태이고, 이건 「없는 의무」가 아니라
   * 「우리 데이터의 공백」이라 화면이 대조 불가로 표면화해야 한다(지우면 안 된다).
   */
  it("사업자 셀러의 번호만 비어 있으면 기대 건은 남기되 상대 번호가 null 이다", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "BRAND_MALL", sellerTaxType: "BUSINESS", sellerBusinessNumber: null }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].counterpartBusinessNumber).toBeNull();
  });

  it("완료 기록 시각을 그대로 실어 보낸다", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "BRAND_MALL", sellerInvoiceIssuedAt: "2026-08-01T00:00:00.000Z" }),
    );
    expect(rows[0].alreadyMarkedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

// 정산 그룹 — 「셀러·공급사 둘 다 그룹당 한 장을 합산해서 끊는다」(오너 확정 2026-08-04,
// 설계 문서 「✅ 정산 그룹의 계산서 장수 — 확정」절). 캠페인별로 기대액을 만들면 그룹
// 건의 실제 계산서 총액과 어느 캠페인의 기대액도 맞지 않아 영구히 AMOUNT_MISMATCH로
// 떨어진다(이번 정정의 계기) — 이 블록이 그 회귀를 고정한다.
describe("buildGroupExpectedReceivables — 정산 그룹(그룹당 계산서 1장)", () => {
  const groupFacts = (id: string, overrides: Partial<CampaignSettlementFacts> = {}): CampaignSettlementFacts =>
    facts({
      campaignId: id,
      salesChannel: "OWN_MALL",
      sellerBusinessNumber: "1112233333", // 동일 셀러 — CampaignGroup.sellerId 불변식
      partnerBusinessNumber: "4445566666", // 기본은 동일 공급사(uniform 케이스)
      ...overrides,
    });

  it("미그룹(멤버 1건)은 buildExpectedReceivables 와 동일하다", () => {
    const solo = groupFacts("camp1", {
      actualSales: 10_000_000,
      settlementSales: 3_000_000,
      sellerExpense: 2_000_000,
    });
    expect(buildGroupExpectedReceivables([solo])).toEqual(buildExpectedReceivables(solo));
  });

  it("멤버 0건이면 빈 배열", () => {
    expect(buildGroupExpectedReceivables([])).toEqual([]);
  });

  it("상대가 전 멤버 동일한 3인 그룹은 두 슬롯 다 그룹 1건으로 합산한다 — 개별·2인 부분합과 전부 다른 수치로 잘못된 식을 가려낸다", () => {
    const a = groupFacts("campA", { actualSales: 10_000_000, settlementSales: 3_000_000, sellerExpense: 2_000_000 }); // 물품비 7,000,000 · 수수료 2,000,000
    const b = groupFacts("campB", { actualSales: 6_000_000, settlementSales: 1_000_000, sellerExpense: 1_300_000 }); // 물품비 5,000,000 · 수수료 1,300,000
    const c = groupFacts("campC", { actualSales: 4_000_000, settlementSales: 500_000, sellerExpense: 900_000 }); // 물품비 3,500,000 · 수수료 900,000

    // 입력 순서가 결과에 영향을 주지 않아야 한다 — 대표(anchor)는 id 오름차순으로 고정된다.
    const rows = buildGroupExpectedReceivables([b, c, a]);

    expect(rows.map((r) => r.slot).sort()).toEqual(["SELLER_COMMISSION", "SUPPLIER_GOODS"]);
    expect(rows).toHaveLength(2);

    const goods = rows.find((r) => r.slot === "SUPPLIER_GOODS")!;
    expect(goods.expectedTotalAmount).toBe(15_500_000); // 7.0m + 5.0m + 3.5m
    expect(goods.expectedTotalAmount).not.toBe(7_000_000); // campA 단독(오답)
    expect(goods.expectedTotalAmount).not.toBe(12_000_000); // campA+campB 2인 부분합(오답)
    expect(goods.expectedTotalAmount).not.toBe(10_500_000); // campA+campC 2인 부분합(오답)
    expect(goods.expectedTotalAmount).not.toBe(8_500_000); // campB+campC 2인 부분합(오답)
    expect(goods.key).toBe("campA:SUPPLIER_GOODS"); // 대표는 id 오름차순 첫 번째(campA)
    expect(goods.amountBasis).toContain("3건 합산");

    const commission = rows.find((r) => r.slot === "SELLER_COMMISSION")!;
    expect(commission.expectedTotalAmount).toBe(4_200_000); // 2.0m + 1.3m + 0.9m
    expect(commission.expectedTotalAmount).not.toBe(3_300_000); // campA+campB
    expect(commission.expectedTotalAmount).not.toBe(2_900_000); // campA+campC
    expect(commission.expectedTotalAmount).not.toBe(2_200_000); // campB+campC
    expect(commission.key).toBe("campA:SELLER_COMMISSION");
  });

  it("공급사가 그룹 안에서 갈리면 SUPPLIER_GOODS 만 캠페인별로 후퇴하고, SELLER_COMMISSION 은 여전히 합산한다(셀러는 항상 동일 불변식)", () => {
    const a = groupFacts("campA", {
      partnerBusinessNumber: "1112223333",
      actualSales: 10_000_000,
      settlementSales: 3_000_000,
      sellerExpense: 2_000_000,
    });
    const b = groupFacts("campB", {
      partnerBusinessNumber: "9998887777",
      actualSales: 6_000_000,
      settlementSales: 1_000_000,
      sellerExpense: 1_300_000,
    });

    const rows = buildGroupExpectedReceivables([a, b]);

    const goodsItems = rows.filter((r) => r.slot === "SUPPLIER_GOODS");
    expect(goodsItems.map((r) => r.key).sort()).toEqual(["campA:SUPPLIER_GOODS", "campB:SUPPLIER_GOODS"]);
    expect(goodsItems.find((r) => r.key === "campA:SUPPLIER_GOODS")!.expectedTotalAmount).toBe(7_000_000);
    expect(goodsItems.find((r) => r.key === "campB:SUPPLIER_GOODS")!.expectedTotalAmount).toBe(5_000_000);

    const commissionItems = rows.filter((r) => r.slot === "SELLER_COMMISSION");
    expect(commissionItems).toHaveLength(1);
    expect(commissionItems[0].key).toBe("campA:SELLER_COMMISSION");
    expect(commissionItems[0].expectedTotalAmount).toBe(3_300_000); // 2,000,000 + 1,300,000 — 여전히 합산
  });

  it("그룹 안에서 채널이 갈리면(board 의 CHANNEL_MISMATCH 가드와 같은 판단) 두 슬롯 다 캠페인별로 후퇴한다", () => {
    const a = groupFacts("campA", {
      salesChannel: "OWN_MALL",
      actualSales: 10_000_000,
      settlementSales: 3_000_000,
      sellerExpense: 2_000_000,
    });
    const b = groupFacts("campB", {
      salesChannel: "BRAND_MALL",
      actualSales: 6_000_000,
      settlementSales: 1_000_000,
      sellerExpense: 1_300_000,
    });

    const rows = buildGroupExpectedReceivables([a, b]);
    const expectedFallback = [...buildExpectedReceivables(a), ...buildExpectedReceivables(b)];
    expect(rows.map((r) => r.key).sort()).toEqual(expectedFallback.map((r) => r.key).sort());
  });

  it("멤버 중 하나라도 금액 원천이 비어 있으면 그룹 합산액도 0 이 아니라 null(모름)이다 — 일부만 반영된 합계를 완전한 합계처럼 보이지 않게 한다", () => {
    const a = groupFacts("campA", { actualSales: 10_000_000, settlementSales: 3_000_000, sellerExpense: null });
    const b = groupFacts("campB", { actualSales: 6_000_000, settlementSales: 1_000_000, sellerExpense: 1_300_000 });

    const rows = buildGroupExpectedReceivables([a, b]);
    const commission = rows.find((r) => r.slot === "SELLER_COMMISSION")!;
    expect(commission.expectedTotalAmount).toBeNull();
    expect(commission.expectedTotalAmount).not.toBe(1_300_000); // b 만 반영된 값(오답)
  });
});

describe("수기 물품대금(manualGoodsCost) — 있으면 정본, 없으면 공식 폴백", () => {
  // 실측(2026-08-06)에서 공식이 실물과 자주 어긋났다(수치는 모드 L 워크시트). 값은 전부 가짜지만 **관계**는 실측과 같다:
  // 수기값은 공식 결과와 겹치지 않게 잡는다 — 겹치면 어느 쪽을 썼는지 이 테스트가 못 가른다.
  const FORMULA = 10_000_000 - 5_000_000; // = 5,000,000
  const MANUAL = 4_889_470;

  function goodsRow(overrides: Partial<CampaignSettlementFacts>) {
    const rows = buildExpectedReceivables(facts({ salesChannel: "OWN_MALL_NAVER", ...overrides }));
    const row = rows.find((item) => item.slot === "SUPPLIER_GOODS");
    if (!row) throw new Error("SUPPLIER_GOODS 슬롯이 없다");
    return row;
  }

  it("수기값이 있으면 그 값이 기대액이고 amountIsManual 이 참이다", () => {
    const row = goodsRow({ manualGoodsCost: MANUAL });
    expect(row.expectedTotalAmount).toBe(MANUAL);
    expect(row.amountIsManual).toBe(true);
    // 음성 대조군 — 공식 결과로 되돌아가면 실패한다.
    expect(row.expectedTotalAmount).not.toBe(FORMULA);
  });

  it("수기값이 없으면 현행 공식으로 폴백하고 amountIsManual 이 거짓이다", () => {
    for (const absent of [undefined, null]) {
      const row = goodsRow({ manualGoodsCost: absent });
      expect(row.expectedTotalAmount).toBe(FORMULA);
      expect(row.amountIsManual).toBe(false);
    }
  });

  it("셀러몰에서도 같은 우선순위가 적용된다(같은 공식을 쓰는 슬롯이므로)", () => {
    const row = goodsRow({ salesChannel: "SELLER_MALL", manualGoodsCost: MANUAL });
    expect(row.expectedTotalAmount).toBe(MANUAL);
    expect(row.amountIsManual).toBe(true);
  });

  it("수기값 0 = 「다른 캠페인 계산서에 합산됨」 — 물품비 기대 건을 만들지 않는다", () => {
    // 오너 확정(2026-08-06): 자체 판매분은 별도 셀러의 캠페인으로 집계하되 계산서는 두
    // 캠페인 합산 1장이다. 0 을 '0원 기대'로 만들면 존재하지 않는 계산서를 영원히
    // 기다리는 유령 경보가 된다 — 0원짜리 세금계산서는 실무상 없다.
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "OWN_MALL_NAVER", manualGoodsCost: 0 }),
    );
    expect(rows.find((item) => item.slot === "SUPPLIER_GOODS")).toBeUndefined();
    // 음성 대조군 — 셀러 수수료 슬롯은 살아남아야 한다(합산되는 것은 물품대금 계산서뿐).
    expect(rows.find((item) => item.slot === "SELLER_COMMISSION")).toBeDefined();
  });

  it("셀러몰에서도 0 은 같은 억제로 동작한다", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "SELLER_MALL", manualGoodsCost: 0 }),
    );
    expect(rows).toEqual([]);
  });

  it("⛔ 셀러 수수료 슬롯은 수기 물품대금에 오염되지 않는다", () => {
    const rows = buildExpectedReceivables(
      facts({ salesChannel: "OWN_MALL_NAVER", manualGoodsCost: MANUAL }),
    );
    const commission = rows.find((item) => item.slot === "SELLER_COMMISSION");
    expect(commission?.expectedTotalAmount).toBe(2_000_000);
    expect(commission?.amountIsManual).toBe(false);
  });

  it("근거 문구가 두 경로에서 서로 달라 화면이 출처를 말할 수 있다", () => {
    expect(goodsRow({ manualGoodsCost: MANUAL }).amountBasis).toContain("수기");
    expect(goodsRow({}).amountBasis).toContain("총매출 − 영업수익");
    // 음성 대조군 — 폴백 문구가 수기라고 말하기 시작하면 실패한다.
    expect(goodsRow({}).amountBasis).not.toContain("수기");
  });
});

describe("수기 물품대금 × 정산 그룹 — 부분 합산 금지", () => {
  const groupFact = (id: string, overrides: Partial<CampaignSettlementFacts> = {}) =>
    facts({
      campaignId: id,
      salesChannel: "OWN_MALL_NAVER",
      actualSales: 6_000_000,
      settlementSales: 2_000_000,
      ...overrides,
    });

  function groupGoodsRows(members: CampaignSettlementFacts[]) {
    return buildGroupExpectedReceivables(members).filter((item) => item.slot === "SUPPLIER_GOODS");
  }

  it("멤버 전원이 수기값을 가지면 합산해 그룹 1건을 낸다", () => {
    const rows = groupGoodsRows([
      groupFact("a", { manualGoodsCost: 3_900_000 }),
      groupFact("b", { manualGoodsCost: 1_100_000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].expectedTotalAmount).toBe(5_000_000);
    expect(rows[0].amountIsManual).toBe(true);
  });

  it("⛔ 멤버 하나라도 비어 있으면 그룹 전체가 공식 폴백이다(입력된 멤버만 더하지 않는다)", () => {
    const rows = groupGoodsRows([
      groupFact("a", { manualGoodsCost: 3_900_000 }),
      groupFact("b"),
    ]);
    expect(rows).toHaveLength(1);
    // 공식: (6,000,000+6,000,000) − (2,000,000+2,000,000) = 8,000,000
    expect(rows[0].expectedTotalAmount).toBe(8_000_000);
    expect(rows[0].amountIsManual).toBe(false);
    // 음성 대조군 — 부분 합산(3,900,000)으로 회귀하면 실패한다.
    expect(rows[0].expectedTotalAmount).not.toBe(3_900_000);
  });

  it("⛔ 대표(anchor) 멤버의 수기값이 그룹 전체 값으로 새지 않는다", () => {
    // anchor 는 campaignId 오름차순 = "a". 그 값만 있고 "b" 는 비어 있다.
    const rows = groupGoodsRows([groupFact("a", { manualGoodsCost: 12_345 }), groupFact("b")]);
    expect(rows[0].expectedTotalAmount).not.toBe(12_345);
    expect(rows[0].amountIsManual).toBe(false);
  });
});

describe("수기 물품대금 0(합산 이관) × 정산 그룹", () => {
  const g = (id: string, overrides: Partial<CampaignSettlementFacts> = {}) =>
    facts({
      campaignId: id,
      salesChannel: "OWN_MALL_NAVER",
      actualSales: 6_000_000,
      settlementSales: 2_000_000,
      ...overrides,
    });

  it("멤버 일부가 0 이면 합산에 0 으로 기여한다(그룹 총액 = 나머지 합)", () => {
    const rows = buildGroupExpectedReceivables([
      g("a", { manualGoodsCost: 3_900_000 }),
      g("b", { manualGoodsCost: 0 }),
    ]).filter((item) => item.slot === "SUPPLIER_GOODS");
    expect(rows).toHaveLength(1);
    expect(rows[0].expectedTotalAmount).toBe(3_900_000);
    expect(rows[0].amountIsManual).toBe(true);
  });

  it("그룹 전원이 0 이면 그룹의 물품비 기대 건 자체가 없다", () => {
    const rows = buildGroupExpectedReceivables([
      g("a", { manualGoodsCost: 0 }),
      g("b", { manualGoodsCost: 0 }),
    ]);
    expect(rows.find((item) => item.slot === "SUPPLIER_GOODS")).toBeUndefined();
    expect(rows.find((item) => item.slot === "SELLER_COMMISSION")).toBeDefined();
  });
});
