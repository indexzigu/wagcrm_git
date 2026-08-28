/**
 * tax-invoice-builder.ts 계약 테스트 — 2026-08-04 「빌더 정정」 재작성판.
 *
 * ⛔ 이전 버전은 `buildTaxInvoiceRows(campaigns: CampaignRow[])`가 캠페인에서 금액·
 * 상대를 직접 유도하는 옛(틀린) 모델을 고정하고 있었다 — 공급받는자를 `sellerCompany*`
 * 로 하드코딩(브랜드몰 발행에서 상대가 항상 틀림), 금액을 `sellerExpense`/`actualSales`
 * 에서 딜 개수 기준으로 다시 계산(셀러몰 발행이 셀러 수수료 전액만큼 과다청구). 이
 * 테스트들은 그 틀린 모델의 동작을 그대로 assertion 으로 고정하고 있었다.
 *
 * 지금은 `buildTaxInvoiceRows`가 `tax-filing-board.buildTaxInvoiceObligationRows`
 * 가 낸 행을 그대로 소비한다 — 이 파일의 테스트는 그 소비 계약(counterpart 분기,
 * amount 재계산 금지, 그룹 1행=1장, RECEIVE 제외, 상대별 결번 검증)을 고정한다.
 * 옛 assertion 은 전부 버렸다 — 유지하면 틀린 모델을 다시 회귀시킨다.
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  normalizeBusinessNumber,
  buildTaxInvoiceRows,
  validateTaxInvoiceCampaigns,
  resolveInvoiceDate,
  buildInvoiceLineItems,
  SUPPLIER,
} from "@/lib/tax-invoice-builder";
import { countHometaxBytes, HOMETAX_TEXT_MAX_BYTES } from "@/lib/hometax-text";
import { buildTaxInvoiceObligationRows, type TaxInvoiceBoardRow } from "@/lib/tax-filing-board";
import type { CampaignRow } from "@/lib/crm-types";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealId: "d1",
    dealName: "딜A",
    campaignName: "딜A - 셀러1 1차",
    partnerName: "공급사A",
    partnerBusinessNumber: "1112223334",
    partnerCeoName: "파트너대표",
    partnerAddress: "서울시 강남구 공급사로 1",
    partnerBusinessType: "제조업",
    partnerBusinessItem: "화장품",
    partnerEmail: "partner@example.com",
    sellerId: "s1",
    sellerName: "셀러1",
    endDate: "2026-07-10",
    payoutCompletedAt: "2026-07-20",
    salesChannel: "SELLER_MALL",
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "9998887776",
    sellerCompanyAddress: "서울시 송파구 셀러로 1",
    sellerCompanyBusinessType: "소매업",
    sellerCompanyBusinessItem: "전자상거래",
    sellerCompanyEmail: "seller@example.com",
    actualSales: 11_000_000,
    sellerExpense: 2_200_000,
    settlementSales: 5_500_000,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    ...overrides,
  } as CampaignRow;
}

function issueRowsFor(campaigns: CampaignRow[]): TaxInvoiceBoardRow[] {
  return buildTaxInvoiceObligationRows(campaigns).rows.filter((r) => r.direction === "ISSUE");
}

function indexById(campaigns: CampaignRow[]): Map<string, CampaignRow> {
  return new Map(campaigns.map((c) => [c.id, c]));
}

// ─────────────────────────────────────────────────────────────
// normalizeBusinessNumber
// ─────────────────────────────────────────────────────────────

describe("normalizeBusinessNumber", () => {
  it("하이픈 포함 번호를 10자리 숫자로 정규화한다", () => {
    expect(normalizeBusinessNumber("123-45-67890")).toBe("1234567890");
  });

  it("공백·특수문자 혼재 케이스도 숫자만 추출한다", () => {
    expect(normalizeBusinessNumber(" 123 - 45 - 67890 ")).toBe("1234567890");
  });
});

// ─────────────────────────────────────────────────────────────
// 채널별 상대·금액 — 스펙 표의 핵심 계약
// ─────────────────────────────────────────────────────────────

describe("buildTaxInvoiceRows — 브랜드몰 발행 → 공급사, settlementSales 기준", () => {
  const campaign = makeCampaign({
    id: "brand-1",
    salesChannel: "BRAND_MALL",
    actualSales: 10_000_000, // 오너 예시: 매출 1,000만
    settlementSales: 5_000_000, // RS 50%
    sellerExpense: 2_000_000, // 셀러 수수료 20% (참고용 — 이 행의 amount 와 무관)
    partnerName: "브랜드공급사",
    partnerBusinessNumber: "1234512345",
    partnerCeoName: "공급사대표",
    partnerAddress: "부산시 해운대구 공급사대로 99",
    partnerBusinessType: "제조업",
    partnerBusinessItem: "생활용품",
    partnerEmail: "brand-partner@example.com",
  });

  it("행의 상대가 SUPPLIER 이고 금액이 settlementSales 기준이다", () => {
    const rows = issueRowsFor([campaign]);
    expect(rows).toHaveLength(1);
    expect(rows[0].counterpart).toBe("SUPPLIER");

    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));
    expect(invoices).toHaveLength(1);

    const expectedSupply = Math.round(5_000_000 / 1.1); // = 4,545,455
    const expectedTax = Math.round(expectedSupply * 0.1);
    expect(invoices[0].totalSupplyAmount).toBe(expectedSupply);
    expect(invoices[0].totalTaxAmount).toBe(expectedTax);
  });

  it("공급받는자는 공급사(partner) 필드다 — 7개 필드 전부 공급사 값이고 셀러 값이 아니다", () => {
    const rows = issueRowsFor([campaign]);
    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));

    // ⛔ 이 assertion 들이 실패하면 공급받는자가 셀러로 잘못 주소됐다는 뜻이다 —
    // 옛 버전이 바로 이 오류를 냈다(공급받는자를 항상 sellerCompany*로 하드코딩).
    // 상호·사업자번호·대표자만 고정하면 나머지 4개 필드(주소·업태·종목·이메일)를
    // 셀러 것으로만 채워도 그 세 필드는 여전히 통과한다 — 그래서 7개 전부를 건다.
    expect(invoices[0].buyerBusinessNumber).toBe("1234512345");
    expect(invoices[0].buyerName).toBe("브랜드공급사");
    expect(invoices[0].buyerCeo).toBe("공급사대표");
    expect(invoices[0].buyerAddress).toBe("부산시 해운대구 공급사대로 99");
    expect(invoices[0].buyerBusinessType).toBe("제조업");
    expect(invoices[0].buyerBusinessItem).toBe("생활용품");
    expect(invoices[0].buyerEmail1).toBe("brand-partner@example.com");

    // 어느 하나도 셀러 필드 값과 같지 않아야 한다(우연한 일치가 아니라 다른
    // 출처에서 왔다는 것을 보장하려면 값 자체를 서로 다르게 픽스처에 심어야
    // 한다 — makeCampaign 기본값이 이미 그렇게 돼 있다).
    expect(invoices[0].buyerName).not.toBe(campaign.sellerCompanyName);
    expect(invoices[0].buyerAddress).not.toBe(campaign.sellerCompanyAddress);
    expect(invoices[0].buyerBusinessType).not.toBe(campaign.sellerCompanyBusinessType);
    expect(invoices[0].buyerBusinessItem).not.toBe(campaign.sellerCompanyBusinessItem);
    expect(invoices[0].buyerEmail1).not.toBe(campaign.sellerCompanyEmail);
  });

  it("금액은 actualSales 전액이 아니다 — settlementSales(영업수익) 기준이어야 한다", () => {
    const rows = issueRowsFor([campaign]);
    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));

    const wrongSupplyFromActualSales = Math.round(10_000_000 / 1.1);
    expect(invoices[0].totalSupplyAmount).not.toBe(wrongSupplyFromActualSales);
  });
});

describe("buildTaxInvoiceRows — 셀러몰 발행 → 셀러, actualSales−sellerExpense 기준", () => {
  const campaign = makeCampaign({
    id: "seller-mall-1",
    salesChannel: "SELLER_MALL",
    actualSales: 1_100_000,
    sellerExpense: 220_000, // 셀러 수수료 20%
    sellerCompanyName: "셀러몰상호",
    sellerCompanyBusinessNumber: "5556667778",
    sellerCompanyCeoName: "셀러대표",
    sellerCompanyAddress: "대전시 유성구 셀러대로 10",
    sellerCompanyBusinessType: "소매업",
    sellerCompanyBusinessItem: "생활잡화",
    sellerCompanyEmail: "seller-mall@example.com",
  });

  it("행의 상대가 SELLER 이고 금액이 actualSales−sellerExpense 기준이다", () => {
    const rows = issueRowsFor([campaign]);
    expect(rows).toHaveLength(1);
    expect(rows[0].counterpart).toBe("SELLER");

    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));
    expect(invoices).toHaveLength(1);

    const expectedBase = 1_100_000 - 220_000; // = 880,000
    const expectedSupply = Math.round(expectedBase / 1.1);
    const expectedTax = Math.round(expectedSupply * 0.1);
    expect(invoices[0].totalSupplyAmount).toBe(expectedSupply);
    expect(invoices[0].totalTaxAmount).toBe(expectedTax);
  });

  it("공급받는자는 셀러 회사다 — 7개 필드 전부 셀러 값이고 공급사 값이 아니다", () => {
    const rows = issueRowsFor([campaign]);
    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));

    expect(invoices[0].buyerBusinessNumber).toBe("5556667778");
    expect(invoices[0].buyerName).toBe("셀러몰상호");
    expect(invoices[0].buyerCeo).toBe("셀러대표");
    expect(invoices[0].buyerAddress).toBe("대전시 유성구 셀러대로 10");
    expect(invoices[0].buyerBusinessType).toBe("소매업");
    expect(invoices[0].buyerBusinessItem).toBe("생활잡화");
    expect(invoices[0].buyerEmail1).toBe("seller-mall@example.com");

    expect(invoices[0].buyerName).not.toBe(campaign.partnerName);
    expect(invoices[0].buyerAddress).not.toBe(campaign.partnerAddress);
    expect(invoices[0].buyerBusinessType).not.toBe(campaign.partnerBusinessType);
    expect(invoices[0].buyerBusinessItem).not.toBe(campaign.partnerBusinessItem);
    expect(invoices[0].buyerEmail1).not.toBe(campaign.partnerEmail);
  });

  it("금액은 actualSales 전액이 아니다 — 그러면 셀러 수수료만큼 과다청구된다", () => {
    const rows = issueRowsFor([campaign]);
    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));

    // ⛔ 이 값과 같으면 옛 버전의 과다청구 버그가 재발한 것이다.
    const wrongSupplyFromActualSalesAlone = Math.round(1_100_000 / 1.1);
    expect(invoices[0].totalSupplyAmount).not.toBe(wrongSupplyFromActualSalesAlone);
  });
});

// ─────────────────────────────────────────────────────────────
// 품목 합계 = 행 금액 (홈택스 규칙)
// ─────────────────────────────────────────────────────────────

describe("buildTaxInvoiceRows — 품목 합계는 행 금액과 정확히 일치한다", () => {
  it("단일 캠페인 행", () => {
    const campaign = makeCampaign({ id: "c-sum-1", salesChannel: "SELLER_MALL" });
    const rows = issueRowsFor([campaign]);
    const [invoice] = buildTaxInvoiceRows(rows, indexById([campaign]));

    const lineItemSupplySum = invoice.lineItems.reduce((acc, item) => acc + item.supplyAmount, 0);
    const lineItemTaxSum = invoice.lineItems.reduce((acc, item) => acc + item.taxAmount, 0);
    expect(lineItemSupplySum).toBe(invoice.totalSupplyAmount);
    expect(lineItemTaxSum).toBe(invoice.totalTaxAmount);
  });

  // ⚠️ whole-branch 리뷰 지적(2026-08-04) — 이 테스트는 사실상 동어반복이다.
  // `buildTaxInvoiceRows`가 단일 품목의 supplyAmount/taxAmount 를 `row.amount`에서
  // 그대로 복사하고, invoice 의 totalSupplyAmount/totalTaxAmount 도 같은
  // `row.amount`에서 그대로 복사한다(둘 다 재계산이 없다) — 그러니 "품목 합계 =
  // 합계"는 구현 구조상 항상 참이고, 이 테스트가 그걸 어긋나게 할 수 있는 입력을
  // 찾아낼 수는 없다. 이 보장은 **코드 구성 자체**(같은 값을 두 곳에 그대로 싣는
  // 구조)에서 나오는 것이고, 이 property 테스트가 그걸 검증해서 나오는 게 아니다.
  // 그래도 남겨둔다 — 향후 리팩터로 두 값의 출처가 갈라지면(예: lineItem 을
  // 딜별로 다시 쪼개는 변경) 이 테스트가 그 순간 깨져 회귀를 알린다.
  it("Property: 임의의 채널·금액 조합에서도 품목 합계 = 행 금액", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("SELLER_MALL" as const, "BRAND_MALL" as const),
        fc.integer({ min: 100_000, max: 100_000_000 }),
        fc.integer({ min: 1, max: 99 }),
        (channel, actualSales, pct) => {
          const settlementSales = Math.floor((actualSales * pct) / 100);
          const sellerExpense = Math.floor((actualSales * (100 - pct)) / 200);
          const campaign = makeCampaign({
            id: "c-prop",
            salesChannel: channel,
            actualSales,
            settlementSales,
            sellerExpense,
          });
          const rows = issueRowsFor([campaign]);
          if (rows.length === 0) return true; // 결번 등으로 행이 없으면 스킵
          const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));
          if (invoices.length === 0) return true;
          const [invoice] = invoices;
          const supplySum = invoice.lineItems.reduce((acc, item) => acc + item.supplyAmount, 0);
          const taxSum = invoice.lineItems.reduce((acc, item) => acc + item.taxAmount, 0);
          return supplySum === invoice.totalSupplyAmount && taxSum === invoice.totalTaxAmount;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 정산 그룹 = 1행 = 1장 (재계산 없이 행 금액 그대로)
// ─────────────────────────────────────────────────────────────

describe("buildTaxInvoiceRows — 정산 그룹은 한 행 = 한 장", () => {
  it("그룹 행의 금액은 멤버 원금을 합산한 뒤 한 번만 반올림한 값이다 — 멤버별로 각각 반올림해 합친 값과 다를 수 있다", () => {
    // base1 = 1,000,000 - 300,000 = 700,000 → 700,000/1.1 = 636,363.636... → round = 636,364
    // base2 = 500,000 - 150,000 = 350,000  → 350,000/1.1 = 318,181.818... → round = 318,182
    // 멤버별로 각각 반올림해 더하면: 636,364 + 318,182 = 954,546
    // 원금을 먼저 합산(1,050,000)한 뒤 한 번만 반올림하면: 1,050,000/1.1 = 954,545.45... → 954,545
    const member1 = makeCampaign({
      id: "grp-1",
      groupId: "g1",
      salesChannel: "SELLER_MALL",
      actualSales: 1_000_000,
      sellerExpense: 300_000,
    });
    const member2 = makeCampaign({
      id: "grp-2",
      groupId: "g1",
      salesChannel: "SELLER_MALL",
      actualSales: 500_000,
      sellerExpense: 150_000,
    });

    const rows = issueRowsFor([member1, member2]);
    expect(rows).toHaveLength(1); // 그룹이 한 행으로 접힌다

    const invoices = buildTaxInvoiceRows(rows, indexById([member1, member2]));
    expect(invoices).toHaveLength(1); // 한 행 = 한 장

    const separatelyRoundedSum = 636_364 + 318_182;
    const jointlyRoundedOnce = Math.round((700_000 + 350_000) / 1.1);

    expect(jointlyRoundedOnce).not.toBe(separatelyRoundedSum); // 두 계산법이 실제로 다름을 확인
    expect(invoices[0].totalSupplyAmount).toBe(jointlyRoundedOnce); // 행 금액(한 번만 반올림)을 그대로 씀
    expect(invoices[0].totalSupplyAmount).not.toBe(separatelyRoundedSum); // 멤버별 재계산 합산이 아님
  });

  it("그룹 멤버끼리 채널이 다르면 그룹 행이 아니라 캠페인별 행으로 후퇴한다 — 각 행이 별도 세금계산서", () => {
    const member1 = makeCampaign({ id: "mix-1", groupId: "g2", salesChannel: "SELLER_MALL" });
    const member2 = makeCampaign({ id: "mix-2", groupId: "g2", salesChannel: "BRAND_MALL" });

    const rows = issueRowsFor([member1, member2]);
    expect(rows).toHaveLength(2); // 후퇴 — 캠페인별 행

    const invoices = buildTaxInvoiceRows(rows, indexById([member1, member2]));
    expect(invoices).toHaveLength(2);
  });

  // 비고의 역사 — 세 번 바뀌었고 지금이 최종이다:
  //   ①딜별 내역을 통째로 실음(2026-08-04, 그룹 합산으로 333자까지 감)
  //   ②100바이트로 잘라 실음(2026-08-08 · T-025 — 홈택스 상한 실측)
  //   ③**아예 싣지 않음**(2026-08-09 오너 확정 — "잘라도 품목 많으면 길어진다").
  // 딜별 내역의 정본은 CRM 이므로 계산서에 복사하지 않는다. 이 테스트는 ③이
  // 유지되는지(비고를 다시 싣는 회귀가 없는지)를 고정한다.
  it("품목 비고는 작성하지 않는다 — 딜이 아무리 많아도 빈값이다(오너 확정 2026-08-09)", () => {
    const members = Array.from({ length: 6 }, (_, i) =>
      makeCampaign({
        id: `remark-${i}`,
        groupId: "g-remark",
        salesChannel: "SELLER_MALL",
        campaignDeals: [
          { id: `d${i}a`, campaignId: `remark-${i}`, dealId: `deal-${i}a`, dealName: `장기간에걸친공동구매딜이름${i}A`, quantity: 10, actualSales: 110_000 },
          { id: `d${i}b`, campaignId: `remark-${i}`, dealId: `deal-${i}b`, dealName: `장기간에걸친공동구매딜이름${i}B`, quantity: 5, actualSales: 55_000 },
        ],
      }),
    );

    const rows = issueRowsFor(members);
    expect(rows).toHaveLength(1); // 그룹 한 행

    const invoices = buildTaxInvoiceRows(rows, indexById(members));
    for (const item of invoices[0].lineItems) {
      expect(item.remark).toBe("");
    }
    expect(invoices[0].remark).toBe(""); // 상단 비고도 동일
  });

  // 오류 문구가 어느 칸을 가리키는지 화면에서 갈리지 않았으므로(T-025) 우리가 채우는
  // 자유 텍스트 칸은 전부 같은 캡을 받아야 한다 — 비고만 고치면 품목명이 같은 이유로
  // 다시 튕길 때 원인을 처음부터 다시 찾게 된다.
  it("품목명도 홈택스 바이트 상한을 넘지 않는다 — 주 품목과 부가 항목 모두", () => {
    const longLabel = "아주긴브랜드이름과아주긴상품이름이붙은공동구매캠페인명입니다".repeat(3);
    const items = buildInvoiceLineItems({
      mainName: longLabel,
      amount: { supplyAmount: 1_000_000, taxAmount: 100_000 },
      appliedItems: [{ note: longLabel, amount: 110_000 }],
    });

    expect(items.length).toBeGreaterThan(1);
    for (const item of items) {
      expect(countHometaxBytes(item.name)).toBeLessThanOrEqual(HOMETAX_TEXT_MAX_BYTES);
    }
    // 조용히 자르지 않는다 — 잘린 이름에는 말줄임 표시가 남는다.
    expect(items[0].name.endsWith("…")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// RECEIVE 는 파일을 만들지 않는다
// ─────────────────────────────────────────────────────────────

describe("buildTaxInvoiceRows — RECEIVE(수취) 행은 세금계산서를 만들지 않는다", () => {
  it("우리몰은 발행 의무가 전혀 없다 — RECEIVE 행만 나오고 invoices 는 0건", () => {
    const campaign = makeCampaign({ id: "own-1", salesChannel: "OWN_MALL" });
    const { rows } = buildTaxInvoiceObligationRows([campaign]);

    expect(rows.every((r) => r.direction === "RECEIVE")).toBe(true);
    expect(rows.some((r) => r.direction === "ISSUE")).toBe(false);

    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));
    expect(invoices).toHaveLength(0);
  });

  it("ISSUE·RECEIVE 가 섞인 입력에서도 RECEIVE 는 걸러진다", () => {
    // 브랜드몰은 supplierInvoiceIssuedAt(ISSUE)와 sellerInvoiceIssuedAt(RECEIVE)를 함께 낸다.
    const campaign = makeCampaign({ id: "brand-mix-1", salesChannel: "BRAND_MALL" });
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    expect(rows.some((r) => r.direction === "ISSUE")).toBe(true);
    expect(rows.some((r) => r.direction === "RECEIVE")).toBe(true);

    const invoices = buildTaxInvoiceRows(rows, indexById([campaign]));
    expect(invoices).toHaveLength(1);
    expect(invoices[0].buyerName).toBe(campaign.partnerName); // ISSUE(공급사 발행)만 남음
  });
});

// ─────────────────────────────────────────────────────────────
// validateTaxInvoiceCampaigns — counterpart 분기
// ─────────────────────────────────────────────────────────────

describe("validateTaxInvoiceCampaigns — counterpart 분기", () => {
  it("기본값(SELLER)은 셀러 사업자 필드를 검증한다(하위 호환)", () => {
    const campaign = makeCampaign({ sellerCompanyBusinessNumber: null });
    const result = validateTaxInvoiceCampaigns([campaign]);
    expect(result.ok).toBe(false);
  });

  it("counterpart='SUPPLIER' 는 파트너 사업자 필드를 검증한다", () => {
    const missingBizNumber = makeCampaign({ id: "sup-missing", partnerBusinessNumber: null });
    const result = validateTaxInvoiceCampaigns([missingBizNumber], "SUPPLIER");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].missingFields).toContain("사업자등록번호");
    }
  });

  it("SUPPLIER 검증은 sellerExpense 를 보지 않는다 — 셀러 정산금과 무관한 상대다", () => {
    const campaign = makeCampaign({ sellerExpense: 0 }); // 셀러 기준으로는 결번이지만
    const result = validateTaxInvoiceCampaigns([campaign], "SUPPLIER");
    expect(result.ok).toBe(true); // 공급사 필드가 다 있으므로 통과해야 한다
  });
});

describe("buildTaxInvoiceObligationRows — 공급사 상대 결번도 잡힌다(Gap #1)", () => {
  it("브랜드몰 발행인데 공급사 사업자등록번호가 없으면 selectable:false 로 막힌다", () => {
    const campaign = makeCampaign({
      id: "brand-missing-biz",
      salesChannel: "BRAND_MALL",
      partnerBusinessNumber: null,
    });
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issueRow = rows.find((r) => r.direction === "ISSUE")!;

    expect(issueRow.selectable).toBe(false);
    expect(issueRow.blockingReasons).toContain("사업자등록번호");
  });

  it("결번 행은 XLSX 생성 후보에서 빠진다(route 가 selectable 만 넘긴다는 계약의 전제)", () => {
    const campaign = makeCampaign({
      id: "brand-missing-ceo",
      salesChannel: "BRAND_MALL",
      partnerCeoName: null,
    });
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issueRow = rows.find((r) => r.direction === "ISSUE")!;
    expect(issueRow.selectable).toBe(false);

    // route.ts 는 selectable 인 ISSUE 행만 buildTaxInvoiceRows 에 넘긴다 — 여기서는 그
    // 필터를 직접 재현해 결번인 ISSUE 행이 넘어가면 안 된다는 계약을 고정한다. (같은
    // 캠페인의 RECEIVE 행은 상대가 셀러라 별도로 selectable:true 일 수 있다 — 그건
    // 이 결번과 무관한 별개 의무이므로 필터에서 배제하지 않는다.)
    const selectableIssueRows = rows.filter((r) => r.direction === "ISSUE" && r.selectable);
    expect(selectableIssueRows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// SUPPLIER 상수 불변성
// ─────────────────────────────────────────────────────────────

describe("buildTaxInvoiceRows — 공급자 필드는 항상 SUPPLIER 상수", () => {
  it("브랜드몰·셀러몰 어느 쪽이든 공급자는 우리 회사(SUPPLIER)로 고정된다", () => {
    const brand = makeCampaign({ id: "sup-const-brand", salesChannel: "BRAND_MALL" });
    const sellerMall = makeCampaign({ id: "sup-const-seller", salesChannel: "SELLER_MALL" });
    const rows = issueRowsFor([brand, sellerMall]);
    const invoices = buildTaxInvoiceRows(rows, indexById([brand, sellerMall]));

    for (const invoice of invoices) {
      expect(invoice.supplierBusinessNumber).toBe(SUPPLIER.businessNumber);
      expect(invoice.supplierName).toBe(SUPPLIER.name);
      expect(invoice.supplierCeo).toBe(SUPPLIER.ceo);
      expect(invoice.supplierAddress).toBe(SUPPLIER.address);
      expect(invoice.supplierEmail).toBe(SUPPLIER.email);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 작성일자 = 공급 연월일 = 캠페인 종료일
// ─────────────────────────────────────────────────────────────

/**
 * ⛔ 이 구획은 **두 번 틀린 자리**다(2026-08-06).
 *
 * ① 처음엔 커버리지가 0 이었다 — `min()` 과 연월 분기를 가진 비자명한 로직인데
 *    테스트가 없어서, 지난달 종료 캠페인의 거래일자가 조용히 오늘 날짜가 되는 동작을
 *    아무도 못 잡았다.
 * ② 그걸 고치겠다며 품목의 **월**을 넣는 방향으로 갔는데, 실화면에서 반증됐다 —
 *    월 칸은 disabled 이고(화면 안내: 「'품목'의 '월'은 상단 '작성일자'의 '월'이 자동
 *    반영됩니다」), 품목 일자가 작성일자보다 뒤면 홈택스가 **조용히 지운다**
 *    (작성일자 08-06 에 일자 10 → 사라짐 / 05 → 유지, 실측).
 *
 * 지금 규칙은 하나다: **작성일자 = 공급 연월일 = 캠페인 종료일**(미래면 오늘로 자름).
 * 그러면 월은 자동으로 맞고, 일 ≤ 작성일도 자동으로 만족한다.
 */
describe("resolveInvoiceDate — 작성일자는 공급 연월일이다", () => {
  const TODAY = new Date(2026, 7, 6); // 2026-08-06

  it("지난달에 끝났으면 그 종료일로 소급한다", () => {
    expect(resolveInvoiceDate("2026-07-10", TODAY)).toBe("20260710");
  });

  it("이번 달에 끝났으면 그 종료일", () => {
    expect(resolveInvoiceDate("2026-08-03", TODAY)).toBe("20260803");
  });

  it("해가 바뀌어도 종료일을 따른다", () => {
    expect(resolveInvoiceDate("2025-12-31", TODAY)).toBe("20251231");
  });

  it("⛔ 미래 종료일은 오늘로 자른다 — 미래 작성일자는 홈택스가 받지 않는다", () => {
    expect(resolveInvoiceDate("2026-08-28", TODAY)).toBe("20260806");
    expect(resolveInvoiceDate("2027-01-01", TODAY)).toBe("20260806");
  });

  it("종료일이 없거나 형식이 깨졌으면 오늘로 폴백한다 — 지어내지 않는다", () => {
    expect(resolveInvoiceDate(null, TODAY)).toBe("20260806");
    expect(resolveInvoiceDate("", TODAY)).toBe("20260806");
    expect(resolveInvoiceDate("2026-13", TODAY)).toBe("20260806");
  });

  it("한 자리 월·일도 두 자리로 맞춘다", () => {
    expect(resolveInvoiceDate("2026-01-05", TODAY)).toBe("20260105");
  });
});

describe("buildTaxInvoiceRows — 작성일자와 품목 일자가 어긋나지 않는다", () => {
  const ISSUED_ON = new Date(2026, 7, 6);

  function invoiceFor(endDate: string | null) {
    const campaign = makeCampaign({ id: "c-date", endDate: endDate as string, salesChannel: "SELLER_MALL" });
    const rows = issueRowsFor([campaign]);
    return buildTaxInvoiceRows(rows, indexById([campaign]), ISSUED_ON)[0];
  }

  it("작성일자가 캠페인 종료일이다 — 발행 당일이 아니다", () => {
    expect(invoiceFor("2026-07-10").invoiceDate).toBe("20260710");
  });

  it("⛔ 품목 일자는 작성일자의 일과 **같다** — 홈택스가 뒤진 일자를 지운다", () => {
    const invoice = invoiceFor("2026-07-10");
    expect(invoice.lineItems[0].date).toBe(invoice.invoiceDate.slice(6, 8));
    expect(invoice.lineItems[0].date).toBe("10");
  });

  it("⛔ 품목 일자가 작성일자보다 뒤인 행을 만들지 않는다(전 구간 불변식)", () => {
    for (const endDate of ["2026-07-10", "2026-08-03", "2025-12-31", "2026-08-28", null]) {
      const invoice = invoiceFor(endDate);
      expect(Number(invoice.lineItems[0].date)).toBeLessThanOrEqual(
        Number(invoice.invoiceDate.slice(6, 8)),
      );
    }
  });

  it("행마다 자기 작성일자를 갖는다 — 종료일이 다르면 날짜도 다르다", () => {
    const a = makeCampaign({ id: "a", endDate: "2026-07-10", salesChannel: "SELLER_MALL" });
    const b = makeCampaign({ id: "b", endDate: "2026-08-01", salesChannel: "SELLER_MALL" });
    const rows = issueRowsFor([a, b]);
    const invoices = buildTaxInvoiceRows(rows, indexById([a, b]), ISSUED_ON);
    expect(new Set(invoices.map((i) => i.invoiceDate)).size).toBe(2);
  });
});


