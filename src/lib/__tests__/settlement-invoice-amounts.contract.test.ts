/**
 * 부가 항목이 **세금계산서 금액**에 반영되는 계약 (2-A, 설계 §9).
 *
 * ## 무엇을 지키나
 *
 * 1. **매핑표는 동형사상이다** — (계산서 방식 × 대상)이 곧 (방향 × 상대)라, 각 금액
 *    기준은 **자기 축의 항목만** 먹는다. 여기가 틀리면 광고비가 엉뚱한 계산서에 실린다.
 * 2. **물품대금은 의도된 예외다** — 매입 부대비용은 실물 계산서에 이미 합산돼 오므로
 *    가산하면 이중 계상이다(§9-3). 이 「안 더한다」는 규칙이 죽어도 테스트가 초록이면
 *    안 되므로 **음성 대조군 + 양성 대조군**을 짝으로 둔다.
 * 3. **세 표면이 같은 숫자를 말한다** — 보드 행 · 발행 기대 건(자동 확정 크론) ·
 *    XLSX. 이 도메인이 여섯 번 정정된 이유가 전부 「화면과 파일이 갈렸다」이다.
 * 4. **품목 합 = 총계** — 홈택스 규칙. 잔차 흡수·4품목 묶기 후에도 항상.
 * 5. **동작 변화 0** — 부가 항목이 0건이면 착지 전후가 같다.
 *
 * ⛔ 픽스처 금액·이름은 전부 **합성값**이다. 프로덕션 실측치·거래처 실명을 넣지 말 것
 * (레포 public, P0). 실데이터 회귀는 홈택스 실조회를 들고 있는 세션이 담당한다.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AMOUNT_BASIS_ITEM_RULE,
  buildTaxInvoiceObligationRows,
  computeBaseAmountForBasis,
  resolveAddableItemAxis,
  type AmountBasis,
} from "../tax-filing-board";
import { buildTaxInvoiceRows, MAX_LINE_ITEMS, buildInvoiceLineItems } from "../tax-invoice-builder";
import { buildGroupExpectedIssuances } from "../tax-invoice-mail/expected-issuances";
import { buildExpectedReceivables } from "../tax-invoice-mail/expected-receivables";
import type { SettlementItemRow } from "../settlement-items";
import type { CampaignRow } from "../crm-types";

const SRC = join(process.cwd(), "src");
const read = (relative: string) => readFileSync(join(SRC, relative), "utf8");

/** VAT 포함 100만원짜리 부가 항목 — 어떤 축이든 이 금액으로 만든다. */
function item(
  invoiceMode: SettlementItemRow["invoiceMode"],
  counterparty: SettlementItemRow["counterparty"],
  amount = 1_100_000,
  note = "광고비",
): SettlementItemRow {
  return { id: `i-${invoiceMode}-${counterparty}`, invoiceMode, counterparty, amount, note, sortOrder: 0 };
}

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealName: "딜A",
    campaignName: "딜A 1차",
    partnerName: "공급사A",
    partnerBusinessNumber: "1231231231",
    partnerCeoName: "공급사대표",
    sellerId: "s1",
    sellerName: "셀러1",
    endDate: "2026-07-10",
    payoutCompletedAt: "2026-07-20",
    salesChannel: "BRAND_MALL",
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "1234567890",
    actualSales: 11_000_000,
    sellerExpense: 2_200_000,
    settlementSales: 5_500_000,
    settlementItems: [],
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    ...overrides,
  } as CampaignRow;
}

const ALL_BASES: AmountBasis[] = [
  "SELLER_COMMISSION",
  "SETTLEMENT_SALES",
  "SALES_MINUS_COMMISSION",
  "SALES_MINUS_SETTLEMENT",
];

/** 계산서에 실릴 수 있는 축 4종 — `NO_INVOICE`·`INTERNAL` 은 타입상 축이 될 수 없다. */
const ALL_AXES = [
  { invoiceMode: "PURCHASE_RECEIVE", counterparty: "BRAND" },
  { invoiceMode: "PURCHASE_RECEIVE", counterparty: "SELLER" },
  { invoiceMode: "SALES_ISSUE", counterparty: "BRAND" },
  { invoiceMode: "SALES_ISSUE", counterparty: "SELLER" },
] as const;

describe("§9-2 매핑표 — 각 기준은 자기 축의 항목만 먹는다(전수)", () => {
  it("4 기준 × 4 축 전수 — 자기 축이면 가산, 아니면 금액 불변", () => {
    // 뺄셈 기준(SALES_MINUS_*)이 결번이 되지 않도록 피연산자를 전부 채운다.
    const facts = { actualSales: 11_000_000, sellerExpense: 2_200_000, settlementSales: 5_500_000 };

    for (const basis of ALL_BASES) {
      const bare = computeBaseAmountForBasis(basis, facts);
      const axis = resolveAddableItemAxis(basis);

      for (const candidate of ALL_AXES) {
        const withItem = computeBaseAmountForBasis(basis, {
          ...facts,
          settlementItems: [item(candidate.invoiceMode, candidate.counterparty)],
        });

        const isOwnAxis =
          axis !== null &&
          axis.invoiceMode === candidate.invoiceMode &&
          axis.counterparty === candidate.counterparty;

        expect(
          withItem.baseAmount,
          `${basis} × ${candidate.invoiceMode}/${candidate.counterparty} — ${isOwnAxis ? "가산돼야" : "불변이어야"} 한다`,
        ).toBe(isOwnAxis ? bare.baseAmount + 1_100_000 : bare.baseAmount);
      }
    }
  });

  it("계산서 없는 항목(NO_INVOICE · INTERNAL)은 어떤 기준에도 가산되지 않는다", () => {
    const facts = { actualSales: 11_000_000, sellerExpense: 2_200_000, settlementSales: 5_500_000 };
    const invisible: SettlementItemRow[] = [
      item("NO_INVOICE", "SELLER", 990_000, "개인 셀러 광고비"),
      item("NO_INVOICE", "INTERNAL", 60_000, "잡이익"),
    ];
    for (const basis of ALL_BASES) {
      expect(computeBaseAmountForBasis(basis, { ...facts, settlementItems: invisible }).baseAmount).toBe(
        computeBaseAmountForBasis(basis, facts).baseAmount,
      );
    }
  });

  it("매핑표가 모든 금액 기준을 덮는다 — 새 기준이 생기면 여기서 걸린다", () => {
    for (const basis of ALL_BASES) expect(AMOUNT_BASIS_ITEM_RULE[basis]).toBeDefined();
    expect(Object.keys(AMOUNT_BASIS_ITEM_RULE).sort()).toEqual([...ALL_BASES].sort());
  });
});

describe("§9-3 물품대금 예외 — 관련 있지만 일부러 안 더한다", () => {
  const purchaseFromBrand = [item("PURCHASE_RECEIVE", "BRAND", 60_000, "반품배송비")];

  it("음성 대조군 — 매입 부대비용이 있어도 물품대금 금액은 불변이다", () => {
    const bare = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      actualSales: 11_000_000,
      settlementSales: 5_500_000,
    });
    const withItem = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      actualSales: 11_000_000,
      settlementSales: 5_500_000,
      settlementItems: purchaseFromBrand,
    });
    expect(withItem.baseAmount).toBe(bare.baseAmount);
  });

  it("수기 물품대금이 있을 때도 불변이다 — 실물 총액에 이미 포함돼 온다", () => {
    const withItem = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      actualSales: 11_000_000,
      settlementSales: 5_500_000,
      settlementGoodsCost: 5_600_000,
      settlementItems: purchaseFromBrand,
    });
    expect(withItem.baseAmount).toBe(5_600_000);
  });

  it("양성 대조군 — 「안 더한다」가 죽은 코드가 아니라 배지로 살아 있다", () => {
    // 이 단언이 없으면 규칙이 「그 축을 아예 모른다」로 퇴화해도 위 두 테스트가 초록이다.
    const rows = buildTaxInvoiceObligationRows([
      makeCampaign({ salesChannel: "OWN_MALL", settlementItems: purchaseFromBrand }),
    ]);
    const goodsRow = rows.rows.find((r) => r.counterpart === "SUPPLIER" && r.direction === "RECEIVE");
    expect(goodsRow?.settlementItemEffect.applied).toEqual([]);
    expect(goodsRow?.settlementItemEffect.unapplied.count).toBe(1);
    expect(goodsRow?.settlementItemEffect.unapplied.total).toBe(60_000);
    expect(goodsRow?.settlementItemEffect.unapplied.reason).toContain("물품대금");
  });
});

describe("§9-7-4 세 표면이 같은 숫자를 말한다", () => {
  const campaign = makeCampaign({
    salesChannel: "BRAND_MALL",
    settlementItems: [item("SALES_ISSUE", "BRAND", 2_200_000, "광고비")],
  });

  it("보드 행 = 영업수익 + 부가 항목", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issue = rows.find((r) => r.direction === "ISSUE");
    // 원금 5,500,000 + 2,200,000 = 7,700,000 → 공급가액 7,000,000 · 세액 700,000
    expect(issue?.amount).toEqual({ supplyAmount: 7_000_000, taxAmount: 700_000 });
  });

  it("발행 기대 건(자동 확정 크론)이 보드와 같은 금액을 낸다", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issue = rows.find((r) => r.direction === "ISSUE")!;

    const [expected] = buildGroupExpectedIssuances([
      {
        campaignId: campaign.id,
        campaignLabel: campaign.campaignName!,
        salesChannel: campaign.salesChannel,
        // ⚠️ `CampaignRow` 의 이 필드들은 optional(`| undefined`)이고 대조 엔진의
        //    `CampaignIssuanceFacts` 는 `| null` 이다 — `?? null` 없이 그대로 넘기면
        //    타입이 안 맞는다(교차 검증에서 적발). 두 계층의 「없음」 표현이 다르다.
        actualSales: campaign.actualSales ?? null,
        settlementSales: campaign.settlementSales ?? null,
        sellerExpense: campaign.sellerExpense ?? null,
        settlementItems: campaign.settlementItems,
        sellerBusinessNumber: campaign.sellerCompanyBusinessNumber ?? null,
        sellerLabel: campaign.sellerName,
        partnerBusinessNumber: campaign.partnerBusinessNumber ?? null,
        partnerLabel: campaign.partnerName,
        supplierInvoiceIssuedAt: null,
        sellerInvoiceIssuedAt: null,
        groupId: null,
      },
    ]);
    // 기대 건은 VAT 포함 원금이고 보드는 공급가액·세액이다 — 같은 원금에서 나왔는지 본다.
    expect(expected.expectedTotalAmount).toBe(7_700_000);
    expect(issue.amount.supplyAmount + issue.amount.taxAmount).toBe(7_700_000);
  });

  it("XLSX 총계가 보드 행과 같고, 품목 합도 그 총계와 같다", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issueRows = rows.filter((r) => r.direction === "ISSUE");
    const [invoice] = buildTaxInvoiceRows(issueRows, new Map([[campaign.id, campaign]]));

    expect(invoice.totalSupplyAmount).toBe(7_000_000);
    expect(invoice.lineItems.reduce((s, i) => s + i.supplyAmount, 0)).toBe(invoice.totalSupplyAmount);
    expect(invoice.lineItems.reduce((s, i) => s + i.taxAmount, 0)).toBe(invoice.totalTaxAmount);
    // 1행 주 품목(영업수익) + 2행 부가 항목.
    expect(invoice.lineItems).toHaveLength(2);
    expect(invoice.lineItems[1].name).toBe("광고비");
  });
});

/**
 * §9-10 실데이터 회귀(2026-08-08) — 동료 세션이 별도 워크트리에서 shipped 함수
 * (`buildTaxInvoiceObligationRows`·`buildTaxInvoiceRows`)를 프로덕션 캠페인 1건으로
 * **직접 호출**해 확인한 값이다(쓰기 없음). **금액을 포함해 전부 합성값**으로
 * 치환한다(P0 — 레포 public. 초판이 캠페인 라벨만 치환하고 금액은 실측 그대로 커밋한
 * 것이 그 자체로 사고였다 — 아래 결과가 정확히 그 재발 방지다).
 *
 * ⚠️ 실측 구조가 §9-7-4 의 합성 픽스처와 다른 지점: **기준액이 항목보다 작다**
 * (여기서는 30만원 vs 110만원). 큰 항목이 작은 기준액에 얹히는 형태가 반올림·
 * 잔차 계산에서 다른 경로를 타는지 확인하는 게 이 케이스의 값어치다.
 */
describe("§9-10 실데이터 회귀 — 기준액보다 큰 항목", () => {
  const campaign = makeCampaign({
    salesChannel: "BRAND_MALL",
    campaignName: "합성캠페인 1차",
    settlementSales: 300_000,
    settlementItems: [item("SALES_ISSUE", "BRAND", 1_100_000, "광고비(브랜드 지원)")],
  });

  it("보드 기대액 — 30만원 기준에 110만원 항목이 얹혀 원금 140만원(공급가액 1,272,727)이 된다", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issue = rows.find((r) => r.direction === "ISSUE");
    expect(issue?.amount).toEqual({ supplyAmount: 1_272_727, taxAmount: 127_273 });
    expect(issue?.blockingReasons).toEqual([]);
    expect(issue?.selectable).toBe(true);
  });

  it("배지 — applied 1건, unapplied 0건(추정 미반영 문구가 안 뜬다)", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issue = rows.find((r) => r.direction === "ISSUE");
    expect(issue?.settlementItemEffect.applied).toEqual([
      { note: "광고비(브랜드 지원)", amount: 1_100_000 },
    ]);
    expect(issue?.settlementItemEffect.unapplied.count).toBe(0);
  });

  it("XLSX 품목 2행 — 광고비 행은 자기 금액을 그대로 분해한 값을 보인다", () => {
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issueRows = rows.filter((r) => r.direction === "ISSUE");
    const [invoice] = buildTaxInvoiceRows(issueRows, new Map([[campaign.id, campaign]]));

    expect(invoice.lineItems).toHaveLength(2);
    expect(invoice.lineItems[1]).toMatchObject({
      name: "광고비(브랜드 지원)",
      supplyAmount: 1_000_000,
      taxAmount: 100_000,
    });
    // 품목 합 = 총계 — 홈택스 업로드 반려 조건(품목합≠총계)에 안 걸린다.
    expect(invoice.lineItems.reduce((s, i) => s + i.supplyAmount, 0)).toBe(invoice.totalSupplyAmount);
    expect(invoice.lineItems.reduce((s, i) => s + i.taxAmount, 0)).toBe(invoice.totalTaxAmount);
  });
});

describe("§9-7-4b 부가 항목 — 수취(셀러 수수료) 기대액", () => {
  it("수취(셀러 수수료) 기대액도 셀러 지급 부가 항목을 더한다", () => {
    const [receivable] = buildExpectedReceivables({
      campaignId: "c1",
      campaignLabel: "딜A 1차",
      salesChannel: "BRAND_MALL",
      actualSales: 11_000_000,
      settlementSales: 5_500_000,
      sellerExpense: 2_200_000,
      settlementItems: [item("PURCHASE_RECEIVE", "SELLER", 550_000, "광고비 전달")],
      sellerBusinessNumber: "1234567890",
      sellerTaxType: "BUSINESS",
      sellerLabel: "○○커머스",
      partnerBusinessNumber: "1231231231",
      partnerLabel: "공급사A",
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
    });
    expect(receivable.slot).toBe("SELLER_COMMISSION");
    expect(receivable.expectedTotalAmount).toBe(2_750_000);
  });

  it("⛔ 셀러 수수료가 미입력이면 부가 항목만으로 숫자를 만들지 않는다", () => {
    const [receivable] = buildExpectedReceivables({
      campaignId: "c1",
      campaignLabel: "딜A 1차",
      salesChannel: "BRAND_MALL",
      actualSales: 11_000_000,
      settlementSales: 5_500_000,
      sellerExpense: null,
      settlementItems: [item("PURCHASE_RECEIVE", "SELLER", 550_000)],
      sellerBusinessNumber: "1234567890",
      sellerTaxType: "BUSINESS",
      sellerLabel: "○○커머스",
      partnerBusinessNumber: "1231231231",
      partnerLabel: "공급사A",
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
    });
    expect(receivable.expectedTotalAmount).toBeNull();
  });
});

describe("§9-5 품목 행 — 잔차 흡수와 4품목 상한", () => {
  it("잔차는 주 품목이 먹는다 — 부가 항목 행은 입력 금액 그대로 보인다", () => {
    // 1,000,003 은 /1.1 이 딱 떨어지지 않아 잔차가 생기는 값이다.
    const items = buildInvoiceLineItems({
      mainName: "주 품목",
      amount: { supplyAmount: 1_000_000, taxAmount: 100_000 },
      appliedItems: [{ note: "광고비", amount: 1_000_003 }],
    });
    expect(items[1].name).toBe("광고비");
    // 부가 항목 행은 자기 금액을 정확히 표현한다.
    expect(items[1].supplyAmount).toBe(Math.round(1_000_003 / 1.1));
    // 합계는 항상 총계와 같다 — 잔차가 어디로 갔든.
    expect(items.reduce((s, i) => s + i.supplyAmount, 0)).toBe(1_000_000);
    expect(items.reduce((s, i) => s + i.taxAmount, 0)).toBe(100_000);
  });

  it("부가 항목이 3개를 넘으면 초과분을 한 행으로 묶어 4품목을 지킨다", () => {
    const items = buildInvoiceLineItems({
      mainName: "주 품목",
      amount: { supplyAmount: 10_000_000, taxAmount: 1_000_000 },
      appliedItems: [
        { note: "가", amount: 1_100_000 },
        { note: "나", amount: 1_100_000 },
        { note: "다", amount: 1_100_000 },
        { note: "라", amount: 1_100_000 },
        { note: "마", amount: 1_100_000 },
      ],
    });
    expect(items).toHaveLength(MAX_LINE_ITEMS);
    // 앞 2건은 개별, 나머지 3건이 묶인다.
    expect(items.map((i) => i.name)).toEqual(["주 품목", "가", "나", "부가 항목 3건"]);
    expect(items.reduce((s, i) => s + i.supplyAmount, 0)).toBe(10_000_000);
  });

  it("비고가 비면 폴백 이름을 쓴다 — 빈 품목명은 홈택스가 받지 않는다", () => {
    const items = buildInvoiceLineItems({
      mainName: "주 품목",
      amount: { supplyAmount: 1_000_000, taxAmount: 100_000 },
      appliedItems: [{ note: "   ", amount: 110_000 }],
    });
    expect(items[1].name).toBe("부가 항목");
  });

  it("음수 부가 항목(역방향 정정)은 계산서 금액을 줄인다", () => {
    // `InvoiceBaseAmountInput` 은 `actualSales` 를 필수로 요구한다 — 이 기준이 그 값을
    // 안 쓰더라도 타입은 캠페인 한 건의 계약이라 채워 넘긴다.
    const facts = { actualSales: 11_000_000, sellerExpense: 2_200_000, settlementSales: 5_500_000 };
    const base = computeBaseAmountForBasis("SETTLEMENT_SALES", facts);
    const corrected = computeBaseAmountForBasis("SETTLEMENT_SALES", {
      ...facts,
      settlementItems: [item("SALES_ISSUE", "BRAND", -500_000, "수정분 차감")],
    });
    expect(corrected.baseAmount).toBe(base.baseAmount - 500_000);
  });

  it("정정이 원금을 다 깎아내면 0원 계산서를 만들지 않고 결번으로 남긴다", () => {
    const result = computeBaseAmountForBasis("SETTLEMENT_SALES", {
      actualSales: 11_000_000,
      sellerExpense: 2_200_000,
      settlementSales: 5_500_000,
      settlementItems: [item("SALES_ISSUE", "BRAND", -5_500_000, "전액 취소")],
    });
    expect(result.blockingReasons.length).toBeGreaterThan(0);
  });
});

describe("§9-7-7 동작 변화 0 — 부가 항목이 없으면 현행과 같다", () => {
  it("부가 항목 0건이면 품목이 1개이고 금액이 그대로다", () => {
    const campaign = makeCampaign({ settlementItems: [] });
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    const issueRows = rows.filter((r) => r.direction === "ISSUE");
    const [invoice] = buildTaxInvoiceRows(issueRows, new Map([[campaign.id, campaign]]));

    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0].name).toBe(campaign.campaignName);
    expect(invoice.totalSupplyAmount).toBe(5_000_000);
  });

  it("`settlementItems` 필드 자체가 없어도(낡은 호출부) 깨지지 않는다", () => {
    const campaign = makeCampaign();
    delete (campaign as { settlementItems?: unknown }).settlementItems;
    const { rows } = buildTaxInvoiceObligationRows([campaign]);
    expect(rows.find((r) => r.direction === "ISSUE")?.amount.supplyAmount).toBe(5_000_000);
  });
});

describe("§9-8 대응하는 의무가 없는 항목은 조용히 사라지지 않는다", () => {
  it("우리몰에 「매출 발행 × 브랜드」 항목을 넣으면 경고가 뜬다", () => {
    // 우리몰의 공급사 방향은 **수취**라 대응하는 발행 의무가 없다 — 설계 §3-3 이
    // 미확정으로 남긴 조합이다. 지어내서 아무 의무에나 붙이지 않고 경고로 넘긴다.
    const { warnings } = buildTaxInvoiceObligationRows([
      makeCampaign({ salesChannel: "OWN_MALL", settlementItems: [item("SALES_ISSUE", "BRAND")] }),
    ]);
    expect(warnings.some((w) => w.includes("대응하는 세금계산서 의무가 없어"))).toBe(true);
  });

  it("정상 조합에는 경고가 붙지 않는다(음성 대조군)", () => {
    const { warnings } = buildTaxInvoiceObligationRows([
      makeCampaign({ salesChannel: "BRAND_MALL", settlementItems: [item("SALES_ISSUE", "BRAND")] }),
    ]);
    expect(warnings.filter((w) => w.includes("대응하는 세금계산서 의무가 없어"))).toEqual([]);
  });

  it("⛔ 개인 셀러에 「매입 수취 × 셀러」 항목을 넣으면 경고가 뜬다 (교차 검증 적발)", () => {
    // 표에는 셀러 상대 의무가 있지만 개인 셀러는 계산서를 주고받지 않아 행이 안 나온다.
    // 초판은 표만 보고 「커버됨」으로 판정해, 실릴 계산서가 영영 없는 항목이 경고 없이
    // 사라졌다 — 이 안전망이 막으려던 바로 그 형태의 침묵형 실패였다.
    const individual = makeCampaign({
      salesChannel: "BRAND_MALL",
      sellerTaxType: "INDIVIDUAL",
      sellerCompanyBusinessNumber: null,
      settlementItems: [item("PURCHASE_RECEIVE", "SELLER", 550_000, "광고비")],
    });
    const { rows, warnings } = buildTaxInvoiceObligationRows([individual]);

    // 셀러 상대 행은 여전히 안 나온다(원천징수 대상이라 정상) …
    expect(rows.filter((r) => r.counterpart === "SELLER")).toEqual([]);
    // … 그러나 이제 항목이 조용히 사라지지 않는다.
    expect(warnings.some((w) => w.includes("대응하는 세금계산서 의무가 없어"))).toBe(true);
  });

  it("개인 셀러라도 「계산서 없음 × 셀러」는 정상이라 경고하지 않는다(음성 대조군)", () => {
    // 설계 §2-2 조합표가 정한 **올바른 인코딩**이다 — 위 경고가 정상 입력까지 잡으면
    // 오너가 경고를 무시하게 된다.
    const { warnings } = buildTaxInvoiceObligationRows([
      makeCampaign({
        salesChannel: "BRAND_MALL",
        sellerTaxType: "INDIVIDUAL",
        sellerCompanyBusinessNumber: null,
        settlementItems: [item("NO_INVOICE", "SELLER", 550_000, "광고비")],
      }),
    ]);
    expect(warnings.filter((w) => w.includes("대응하는 세금계산서 의무가 없어"))).toEqual([]);
  });

  it("이미 발행 완료된 의무는 「커버됨」으로 본다 — 매달 같은 경고를 띄우지 않는다", () => {
    // 그 계산서는 실재한다. 항목이 거기 실렸는지는 보드가 아니라 대조 엔진의 질문이다.
    const { warnings } = buildTaxInvoiceObligationRows([
      makeCampaign({
        salesChannel: "BRAND_MALL",
        supplierInvoiceIssuedAt: "2026-07-15",
        settlementItems: [item("SALES_ISSUE", "BRAND")],
      }),
    ]);
    expect(warnings.filter((w) => w.includes("대응하는 세금계산서 의무가 없어"))).toEqual([]);
  });
});

describe("§9-6-3 DB 배선 — select 누락은 침묵형 실패다", () => {
  /**
   * 부가 항목을 select 하지 않으면 기대액이 안 움직이는데 **오류도 안 난다.** 타입도
   * 테스트도 못 잡는 자리라(필드가 optional 이므로) 소스 스캔이 유일한 수단이다.
   */
  const WIRED_FILES = [
    "app/api/settlement/tax-filing-board/route.ts",
    "app/api/settlement/tax-invoice/route.ts",
    "lib/tax-invoice-mail/campaign-facts.ts",
    "repositories/campaignGroupRepository.ts",
  ];

  it("보드·XLSX·대조 엔진·그룹 상세가 전부 settlementItems 를 조회한다", () => {
    for (const file of WIRED_FILES) {
      expect(read(file), `${file} 이 부가 항목을 조회하지 않는다 — 금액이 조용히 안 움직인다`).toContain(
        "settlementItems",
      );
    }
  });

  it("스캐너가 살아 있다 — 배선이 없는 파일은 잡힌다(음성 대조군)", () => {
    // read() 경로가 틀렸거나 문자열이 어디에나 있으면 위 테스트가 무의미해진다.
    expect(read("lib/vat.ts")).not.toContain("settlementItems");
  });
});

describe("§9-6-1 XLSX 5번째 품목은 현금 칸을 덮어쓴다 — 시끄럽게 실패한다", () => {
  it("상한 상수가 4다 — 이 값은 취향이 아니라 컬럼 배치의 결과다", () => {
    // 품목 i 는 컬럼 23 + i*8 에서 시작하고 55번이 현금이다.
    expect(23 + MAX_LINE_ITEMS * 8).toBe(55);
  });

  it("정상 경로는 절대 상한을 넘기지 않는다", () => {
    const items = buildInvoiceLineItems({
      mainName: "주 품목",
      amount: { supplyAmount: 10_000_000, taxAmount: 1_000_000 },
      appliedItems: Array.from({ length: 20 }, (_, i) => ({ note: `항목${i}`, amount: 110_000 })),
    });
    expect(items.length).toBeLessThanOrEqual(MAX_LINE_ITEMS);
  });
});
