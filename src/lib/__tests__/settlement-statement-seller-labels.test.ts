import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import {
  buildSettlementStatementHtml,
  buildSettlementStatementText,
  SELLER_STATEMENT_LABELS as L,
} from "@/lib/settlement-statement";

/**
 * 셀러가 받는 정산 명세서의 **줄 이름** 계약 (오너 확정 2026-10-21 — 설계서 §14 「추천안 전체 채택」).
 *
 * 근거: 오너 결정 10-17 「계약서 표기보다 셀러가 읽고 이해하기 쉬운 낱말, 내부 돈 이름을 그대로
 * 옮기지 않음」. 숫자·계산·표 순서는 바꾸지 않는다 — 금액 문자열 단언은 낱말 교체 전 출력에서
 * 그대로 옮긴 값이다(같은 픽스처). 금액·이름은 전부 가공이다(P0).
 *
 * 같은 낱말 「공급가액」이 개인(판매 금액의 부가세 제외분)과 사업자(정산금의 부가세 제외분)에서
 * 뜻이 갈려 셀러가 헷갈리던 자리라, 개인 정산서에는 아예 싣지 않고 사업자는 괄호 안에서만 쓴다.
 */

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-labels",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "봄 공구",
    dealName: "봄 공구",
    partnerName: "브랜드",
    sellerName: "셀러 A",
    sellerCompanyName: "셀러 주식회사",
    sellerCompanyBusinessNumber: "1234567890",
    snsType: "INSTAGRAM",
    snsHandle: "seller",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    salesChannel: "BRAND_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 2_200_000,
    sellerExpense: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-09-08T00:00:00.000Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    settlementItems: [{ invoiceMode: "PURCHASE_RECEIVE", counterparty: "SELLER", amount: 50_000 }],
    campaignDeals: [
      { id: "cd-1", campaignId: "campaign-labels", dealId: "d-1", dealName: "옵션 A", quantity: 12, actualSales: 1_200_000, feeRate: 30, sellingPrice: 100_000 },
      { id: "cd-2", campaignId: "campaign-labels", dealId: "d-2", dealName: "옵션 B", quantity: 20, actualSales: 1_000_000, feeRate: 30, sellingPrice: 50_000 },
    ],
    ...overrides,
  } as CampaignRow;
}

const individual: Partial<CampaignRow> = {
  sellerTaxType: "INDIVIDUAL",
  sellerCompanyBusinessNumber: null,
  sellerCompanyName: null,
};

const basisOverride: Partial<CampaignRow> = {
  id: "campaign-basis",
  sellerFeeBasisOverride: 1_800_000,
  sellerExpense: 180_000,
  settlementItems: [],
};

const now = new Date("2026-09-10T00:00:00.000Z");

const FIXTURES = {
  individual: [campaign(individual)],
  business: [campaign()],
  individualBasis: [campaign({ ...individual, ...basisOverride })],
  businessBasis: [campaign(basisOverride)],
  businessMixed: [campaign(), campaign({ ...basisOverride, dealName: "가을 공구", startDate: "2026-09-08" })],
} satisfies Record<string, CampaignRow[]>;

function render(rows: CampaignRow[]) {
  return { html: buildSettlementStatementHtml(rows, now), text: buildSettlementStatementText(rows, now) };
}

/** 셀러 문서에서 사라져야 하는 옛 이름 — 내부 돈 이름·계약서 표기. */
const OLD_LABELS = [
  "총 거래액",
  "판매 대행비",
  "판매대행비",
  "대행비",
  "차인지급액",
  "원천세",
  "수수료율",
  "수수료 정산",
  "캠페인 소계",
  "매출 상세 내역",
  "부가세액",
  "별도 지급 항목",
  "정산 기준액",
];

/** 문서 본문(태그·스타일 제외)의 금액 문자열을 순서대로 — 낱말을 바꿔도 이 열은 그대로여야 한다. */
function amounts(output: string) {
  return output.replace(/<[^>]*>/g, " ").match(/-?[\d,]{3,}원?/g) ?? [];
}

describe("셀러 정산서 줄 이름 (설계서 §14)", () => {
  it.each(Object.entries(FIXTURES))("%s — 옛 이름이 HTML·평문 어디에도 없다", (_name, rows) => {
    const { html, text } = render(rows);
    for (const old of OLD_LABELS) {
      expect(html, `HTML 에 옛 이름 「${old}」`).not.toContain(old);
      expect(text, `평문에 옛 이름 「${old}」`).not.toContain(old);
    }
  });

  it("개인 정산서 — 판매 금액 → 정산 금액(세전) → 세금 공제 → 실제 입금액", () => {
    const { html, text } = render(FIXTURES.individual);
    for (const label of [
      L.common.grossSales,
      L.individual.supplyOfSales,
      L.common.rate,
      L.individual.preTaxPayout,
      L.individual.withholding,
      L.individual.withholdingNote,
      L.individual.postTaxPayout,
      L.common.extraPayout,
      L.common.extraPayoutNote,
      L.common.campaignTotal,
      L.common.detailSection,
    ]) {
      expect(html).toContain(label);
    }
    // 각주는 세금 공제 줄 바로 아래 — 다른 줄보다 먼저 나오면 엉뚱한 줄의 설명으로 읽힌다.
    const taxAt = html.indexOf(L.individual.withholding);
    const noteAt = html.indexOf(L.individual.withholdingNote);
    const payoutAt = html.indexOf(L.individual.postTaxPayout);
    expect(taxAt).toBeLessThan(noteAt);
    expect(noteAt).toBeLessThan(payoutAt);

    expect(html).not.toContain("공급가액");
    expect(text).not.toContain("공급가액");
    for (const label of [L.common.grossSales, L.individual.preTaxPayout, L.individual.withholding, L.individual.withholdingNote, L.individual.postTaxPayout, L.common.extraPayout]) {
      expect(text).toContain(label);
    }
  });

  it("사업자 정산서 — 공급가액은 괄호 안에서만, 세금 공제·실제 입금액 줄은 없다", () => {
    const { html, text } = render(FIXTURES.business);
    for (const label of [L.common.grossSales, L.common.rate, L.business.payout, L.business.supplyOfPayout, L.business.vat, L.common.campaignTotal, L.common.detailSection]) {
      expect(html).toContain(label);
    }
    expect(html.split("공급가액").length - 1).toBe(html.split(L.business.supplyOfPayout).length - 1);
    expect(text.split("공급가액").length - 1).toBe(text.split(L.business.supplyOfPayout).length - 1);
    for (const label of [L.individual.withholding, L.individual.postTaxPayout, L.individual.preTaxPayout, L.individual.supplyOfSales]) {
      expect(html).not.toContain(label);
      expect(text).not.toContain(label);
    }
    expect(text).toContain(L.business.payout);
  });

  it("수동 기준액 정산서 — 판매 금액 대신 정산 계산 기준 금액, 섞이면 꼬리표", () => {
    for (const rows of [FIXTURES.individualBasis, FIXTURES.businessBasis]) {
      const { html, text } = render(rows);
      expect(html).toContain(L.common.basisAmount);
      expect(text).toContain(L.common.basisAmount);
      expect(html).not.toContain(L.common.grossSales);
    }
    const mixed = render(FIXTURES.businessMixed);
    expect(mixed.html).toContain(`${L.common.basisAmount} (캠페인별 기준 합계)`);
    expect(mixed.text).toContain(`${L.common.basisAmount} (캠페인별 기준 합계)`);
  });

  it("금액 열은 낱말 교체 전과 같다", () => {
    // 낱말 교체 전 출력(같은 픽스처)에서 뽑은 금액 열 — 계산·순서가 바뀌면 여기서 갈린다.
    expect(amounts(render(FIXTURES.individual).html)).toEqual(AMOUNTS_BEFORE.individual);
    expect(amounts(render(FIXTURES.business).html)).toEqual(AMOUNTS_BEFORE.business);
    expect(amounts(render(FIXTURES.individualBasis).html)).toEqual(AMOUNTS_BEFORE.individualBasis);
    expect(amounts(render(FIXTURES.businessMixed).html)).toEqual(AMOUNTS_BEFORE.businessMixed);
    // 개인 평문은 줄 순서를 HTML 합계 표 순서로 바꿨다(정산 금액 → 추가 지급 → 세금 공제 → 실제 입금액,
    // 세금 공제에 「-」) — 값의 모음이 같은지로 본다.
    const unsigned = (xs: string[]) => xs.map((x) => x.replace(/^-/, "")).sort();
    expect(unsigned(amounts(render(FIXTURES.individual).text))).toEqual(unsigned(AMOUNTS_BEFORE.individualText));
    expect(amounts(render(FIXTURES.business).text)).toEqual(AMOUNTS_BEFORE.businessText);
  });
});

const AMOUNTS_BEFORE: Record<string, string[]> = {
  individual: ["-2026", "-0910", "2026", "2,200,000원", "2,000,000원", "200,000원", "50,000원", "-8,250원", "241,750원", "2026", "2026", "100,000", "1,090,909", "109,091", "3,600", "105,491", "50,000", "909,091", "90,909", "3,000", "87,909", "2,000,000", "200,000", "6,600", "193,400"],
  business: ["-2026", "-0910", "2026", "123", "-67890", "2,200,000원", "50,000원", "270,000원", "245,455원", "24,545원", "270,000원", "686", "-00667", "35,", "2026", "2026", "100,000", "1,200,000", "109,091", "10,909", "120,000", "50,000", "1,000,000", "90,909", "9,091", "100,000", "2,200,000", "200,000", "20,000", "220,000"],
  individualBasis: ["-2026", "-0910", "2026", "1,800,000원", "180,000원", "-5,940원", "174,060원", "2026", "2026", "1,800,000", "180,000", "5,940", "174,060", "1,800,000", "180,000", "5,940", "174,060"],
  businessMixed: ["-2026", "-0910", "2026", "123", "-67890", "4,000,000원", "50,000원", "450,000원", "409,091원", "40,909원", "450,000원", "686", "-00667", "35,", "2026", "2026", "100,000", "1,200,000", "109,091", "10,909", "120,000", "50,000", "1,000,000", "90,909", "9,091", "100,000", "2,200,000", "200,000", "20,000", "220,000", "2026", "2026", "1,800,000", "163,636", "16,364", "180,000", "1,800,000", "163,636", "16,364", "180,000"],
  individualText: ["2026", "2,200,000원", "50,000원", "241,750원", "200,000원", "8,250원"],
  businessText: ["2026", "2,200,000원", "50,000원", "270,000원", "245,455원", "24,545원"],
};
