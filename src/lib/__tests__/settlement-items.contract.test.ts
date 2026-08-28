/**
 * 정산 **부가 항목**의 경계를 소스 스캔 + 행위로 고정한다.
 *
 * ## 지키는 불변식 (오너 확정)
 *
 * ```
 * 셀러 정산 기준 = actualSales × 셀러수수료율
 * ```
 *
 * 부가 항목(부대비용·통과·잡이익)은 **어떤 조합이라도** 이 기준과 저장 손익 파생에
 * 들어가지 않는다. 위험은 코드가 아니라 **운영**이다 — 세금계산서 금액을 맞추려고
 * 부대비용을 매출·영업수익에 섞는 순간 셀러 정산이 오염된다. 이 설계는 "섞지 않아도
 * 되는 자리"를 만든 것이고, 이 테스트는 그 자리가 파생 계산으로 새지 않는지 본다.
 *
 * ⚠️ 단위 테스트로는 **미래의 새 호출부**를 못 막기 때문에 소스 스캔을 함께 둔다
 * (이 레포가 여러 계약에서 쓰는 방식). 정규식이 깨져도 초록이 되지 않도록
 * **양성 대조군**을 반드시 함께 확인한다.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { calculateDerivedCampaignFinancials } from "../campaign-financials";
import { buildSettlementStatementHtml, buildSettlementStatementText } from "../settlement-statement";
import type { CampaignRow } from "../crm-types";
import type { SettlementItemRow } from "../settlement-items";

const SRC = join(process.cwd(), "src");
const read = (relative: string) => readFileSync(join(SRC, relative), "utf8");

describe("불변식 소스 스캔 — 셀러 정산 기준·저장 손익 파생은 부가 항목을 모른다", () => {
  /**
   * 이 세 파일이 파생의 전부다: 요율 → 영업수익·판매대행비·세금·영업이익.
   * 부가 항목을 여기 끌어들이면 기준액이 오염되고, 그 오염은 명세서·원천징수 신고·
   * 세금계산서까지 그대로 번진다.
   */
  const DERIVATION_FILES = [
    "lib/campaign-financials.ts",
    "lib/revenue-calc.ts",
    "lib/seller-tax-utils.ts",
  ];

  it("파생 계층은 settlement-items 를 import 하지 않는다", () => {
    for (const file of DERIVATION_FILES) {
      const text = read(file);
      expect(text, `${file} 가 부가 항목을 파생에 끌어들였다 — 셀러 정산 기준이 오염된다`).not.toContain(
        "settlement-items",
      );
      expect(text, `${file} 가 부가 항목 테이블을 직접 읽는다`).not.toContain("settlementItems");
    }
  });

  it("스캐너가 살아 있다 — 실제로 import 하는 파일은 잡힌다(양성 대조군)", () => {
    // 이 단언이 없으면 read() 경로가 틀렸을 때도 위 테스트가 초록이다.
    expect(read("lib/settlement-statement.ts")).toContain("settlement-items");
    expect(read("components/crm/campaign-side-panel.tsx")).toContain("settlement-items");
  });

  it("파생 결과는 부가 항목과 무관하다(행위 확인)", () => {
    // 소스 스캔은 "안 읽는다"만 보므로, 실제 숫자가 안 변하는지도 함께 본다.
    const derived = calculateDerivedCampaignFinancials({
      actualSales: 11_000_000,
      operatingExpense: 0,
      miscExpense: 0,
      totalMarginRate: 20,
      sellerMarginRate: 10,
      sellerTaxType: "BUSINESS",
      sellerCompanyBusinessNumber: "1234567890",
    });
    expect(derived.sellerExpense).toBe(1_100_000);
    expect(derived.settlementSales).toBe(2_200_000);
  });
});

// ── 셀러 대면 표면 — 브랜드사·자사 항목은 절대 새지 않는다(P0) ──────────────

const SELLER_ITEM: SettlementItemRow = {
  id: "i-seller",
  invoiceMode: "NO_INVOICE",
  counterparty: "SELLER",
  amount: 550_000,
  note: "광고비",
  sortOrder: 0,
};
const BRAND_ITEM: SettlementItemRow = {
  id: "i-brand",
  invoiceMode: "PURCHASE_RECEIVE",
  counterparty: "BRAND",
  amount: 60_000,
  note: "반품배송비",
  sortOrder: 1,
};
const INTERNAL_ITEM: SettlementItemRow = {
  id: "i-internal",
  invoiceMode: "NO_INVOICE",
  counterparty: "INTERNAL",
  amount: 60_000,
  note: "반품배송비 현금 수취",
  sortOrder: 2,
};

function campaignWith(items: SettlementItemRow[], overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealId: "d1",
    sellerId: "s1",
    dealName: "딜",
    partnerName: "거래처",
    sellerName: "셀러",
    // 기본 픽스처는 **사업자 셀러**다 — 사업자번호가 없으면 `isIndividualSeller` 가
    // 개인으로 판정해 원천세가 붙고, 그러면 이 파일의 "합계가 같다" 단언이 개인 케이스와
    // 뒤섞여 무엇을 보는 테스트인지 흐려진다.
    sellerCompanyBusinessNumber: "1234567890",
    snsType: "INSTAGRAM",
    snsHandle: "@x",
    startDate: "2026-07-01",
    endDate: "2026-07-07",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 11_000_000,
    sellerExpense: 1_000_000,
    settlementSales: 2_200_000,
    totalMarginRate: 20,
    sellerMarginRate: 10,
    netMarginRate: 10,
    status: "COMPLETED",
    isManualMargin: false,
    campaignCount: 1,
    isOrderRegistered: false,
    updatedAt: new Date().toISOString(),
    followerHistory: [],
    activityHistory: [],
    notes: [],
    campaignDeals: [],
    settlementItems: items,
    ...overrides,
  } as CampaignRow;
}

describe("셀러 명세서 — 대상=셀러 항목만 노출한다(P0)", () => {
  it("셀러 항목은 「별도 지급 항목」으로 표시된다", () => {
    const html = buildSettlementStatementHtml([campaignWith([SELLER_ITEM])]);
    expect(html).toContain("별도 지급 항목");
    // 「수수료 정산과 별개」를 명시해야 셀러가 다음 회차 기준에 포함된다고 오해하지 않는다.
    expect(html).toContain("수수료 정산과 별개");
  });

  it("⛔ 브랜드사·자사 항목의 비고와 금액은 어떤 경우에도 등장하지 않는다", () => {
    const campaign = campaignWith([SELLER_ITEM, BRAND_ITEM, INTERNAL_ITEM]);
    for (const surface of [buildSettlementStatementHtml([campaign]), buildSettlementStatementText([campaign])]) {
      // 브랜드사·자사 간 원가·청구·상계 정보다 — 셀러가 볼 문서에 실리면 P0 위반.
      expect(surface).not.toContain("반품배송비");
      expect(surface).not.toContain("반품배송비 현금 수취");
    }
  });

  it("부가 항목이 없으면 그 줄을 만들지 않는다(현행 명세서와 동일)", () => {
    const html = buildSettlementStatementHtml([campaignWith([])]);
    expect(html).not.toContain("별도 지급 항목");
  });

  it("평문과 HTML 이 같은 합계를 말한다 — 갈리면 메일 클라이언트가 다른 금액을 보낸다", () => {
    const campaign = campaignWith([SELLER_ITEM]);
    const text = buildSettlementStatementText([campaign]);
    // 사업자 셀러: 대행비 1,000,000 + 광고비 550,000 = 1,550,000 (원천세 없음)
    expect(text).toContain("1,550,000원");
    expect(buildSettlementStatementHtml([campaign])).toContain("1,550,000원");
  });

  it("개인 셀러는 대행비 + 부가 항목을 합산해 한 줄로 원천징수한다", () => {
    const campaign = campaignWith([SELLER_ITEM], {
      sellerTaxType: "INDIVIDUAL",
      sellerCompanyBusinessNumber: null,
    });
    const text = buildSettlementStatementText([campaign]);
    // 3.3% 를 (1,000,000) 과 (550,000) 에 각각 적용해 합산: 33,000 + 18,150 = 51,150
    expect(text).toContain("51,150원");
  });
});
