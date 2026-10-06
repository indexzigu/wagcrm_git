import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import {
  buildSettlementStatementHtml,
  buildSettlementStatementText,
  computeSettlementPayoutTotals,
  preFlightValidateCampaigns,
} from "@/lib/settlement-statement";

/**
 * 수동 정산 기준액 캠페인의 **셀러 대면 명세서**(오너 확정 2026-10-06).
 *
 * 매출 일부를 우리가 직접 판 캠페인이라 총 거래액·공급가액(actualSales 파생)에 우리 매출이 섞여
 * 있다 — 셀러 문서에는 그 총액이 나가면 안 되고 「정산 기준액」 한 값만 나간다. 조정 사실을
 * 드러내는 문구도 금지. 기준액이 없는 캠페인은 종전 출력 그대로다.
 * 금액·이름은 전부 가공이다(P0).
 */

const GROSS = 10_000_000; // 우리 판매분 400,000 이 섞인 총 거래액(셀러 문서에 나가면 안 되는 값)
const BASIS = 9_600_000;

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-basis",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "가을 공구",
    dealName: "가을 공구",
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
    actualSales: GROSS,
    sellerFeeBasisOverride: BASIS,
    sellerExpense: 960_000,
    settlementSales: 3_000_000,
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
    campaignDeals: [
      { id: "cd-1", campaignId: "campaign-basis", dealId: "d-1", dealName: "옵션 A", quantity: 60, actualSales: 6_000_000, feeRate: 30, sellingPrice: 100_000 },
      { id: "cd-2", campaignId: "campaign-basis", dealId: "d-2", dealName: "옵션 B", quantity: 40, actualSales: 4_000_000, feeRate: 30, sellingPrice: 100_000 },
    ],
    ...overrides,
  };
}

const individual: Partial<CampaignRow> = {
  sellerTaxType: "INDIVIDUAL",
  sellerCompanyBusinessNumber: null,
  sellerCompanyName: null,
};

const now = new Date("2026-09-10T00:00:00.000Z");

/** 셀러 문서에 나가면 안 되는 값 — 총 거래액·그 공급가액·품목 매출·수량·조정 문구. */
function expectNoGross(output: string, isIndividual: boolean) {
  for (const amount of [GROSS, Math.round(GROSS / 1.1), 6_000_000, 4_000_000, Math.round(6_000_000 / 1.1)]) {
    expect(output).not.toContain(amount.toLocaleString());
  }
  expect(output).not.toContain("총 거래액");
  if (isIndividual) expect(output).not.toContain("공급가액");
  for (const word of ["직접 입력", "수동", "조정", "자체 판매", "override"]) expect(output).not.toContain(word);
}

describe("명세서 — 수동 기준액 캠페인은 총 거래액 대신 정산 기준액 한 값", () => {
  it.each([
    ["사업자", {}, false],
    ["개인", individual, true],
  ] as const)("%s: HTML 에 총액이 없고 정산 기준액·저장 판매대행비가 있다", (_label, extra, isIndividual) => {
    const html = buildSettlementStatementHtml([campaign(extra)], now);
    expectNoGross(html, isIndividual);
    expect(html).toContain("정산 기준액");
    expect(html).toContain(BASIS.toLocaleString());
    expect(html).toContain("960,000");
    // 품목 판매가·수량도 싣지 않는다(판매가 × 수량 = 우리 판매분이 섞인 총액).
    expect(html).not.toContain("100,000");
  });

  it.each([
    ["사업자", {}, false],
    ["개인", individual, true],
  ] as const)("%s: 평문도 같은 규칙", (_label, extra, isIndividual) => {
    const text = buildSettlementStatementText([campaign(extra)], now);
    expectNoGross(text, isIndividual);
    expect(text).toContain(`- 정산 기준액: ${BASIS.toLocaleString()}원`);
  });

  it("개인: 원천세·차인지급액은 저장 판매대행비 기준(960,000 × 3.3% = 31,680)", () => {
    const totals = computeSettlementPayoutTotals([campaign({ ...individual, settlementItems: [] })]);
    expect(totals.totalPreTaxPayout).toBe(960_000);
    expect(totals.totalWithholdingTaxOnly).toBe(31_680);
    expect(totals.totalPostTaxPayout).toBe(960_000 - 31_680);
    expect(totals.hasSellerFeeBasisOverride).toBe(true);
    expect(totals.totalSellerFeeBasis).toBe(BASIS);
  });

  it("저장 판매대행비가 없으면 기준액 × 요율로 낸다(총 거래액으로 역산하지 않는다)", () => {
    const totals = computeSettlementPayoutTotals([campaign({ sellerExpense: null })]);
    expect(totals.totalPreTaxPayout).toBe(960_000);
  });
});

describe("명세서 — 수동·자동 캠페인이 섞여도 합계가 맞는다", () => {
  const plain = campaign({
    id: "campaign-plain",
    sellerFeeBasisOverride: null,
    actualSales: 1_000_000,
    sellerExpense: 100_000,
    campaignDeals: [
      { id: "cd-9", campaignId: "campaign-plain", dealId: "d-9", dealName: "옵션 C", quantity: 10, actualSales: 1_000_000, feeRate: 30, sellingPrice: 100_000 },
    ],
  });

  it("합계 첫 줄은 「정산 기준액 (캠페인별 기준 합계)」 = 캠페인별 기준 열 소계의 합(수동 9,600,000 + 자동 1,000,000)", () => {
    const totals = computeSettlementPayoutTotals([campaign(), plain]);
    expect(totals.totalSellerFeeBasis).toBe(BASIS + 1_000_000);
    expect(totals.totalPostTaxPayout).toBe(960_000 + 100_000);

    expect(totals.isMixedSellerFeeBasis).toBe(true);
    const html = buildSettlementStatementHtml([campaign(), plain], now);
    expect(html).toContain("정산 기준액 (캠페인별 기준 합계)");
    expect(html).toContain((BASIS + 1_000_000).toLocaleString());
    expect(html).toContain((960_000 + 100_000).toLocaleString());
    // 수동 캠페인의 총액은 어디에도 없다.
    expect(html).not.toContain(GROSS.toLocaleString());
    expect(buildSettlementStatementText([campaign(), plain], now)).toContain(
      `- 정산 기준액 (캠페인별 기준 합계): ${(BASIS + 1_000_000).toLocaleString()}원`,
    );
  });

  it("개인 셀러 혼합: 자동 캠페인의 기준은 공급가액이라 합이 표 소계와 같다", () => {
    const totals = computeSettlementPayoutTotals([
      campaign(individual),
      { ...plain, ...individual, sellerExpense: 90_909 },
    ]);
    expect(totals.totalSellerFeeBasis).toBe(BASIS + Math.round(1_000_000 / 1.1));
  });
});

describe("명세서 — 기준액이 없는 캠페인은 종전 그대로", () => {
  it("총 거래액·공급가액 줄을 그대로 싣는다", () => {
    const html = buildSettlementStatementHtml([campaign({ ...individual, sellerFeeBasisOverride: null, sellerExpense: null })], now);
    expect(html).toContain("총 거래액");
    expect(html).toContain("└ 공급가액");
    expect(html).not.toContain("정산 기준액");
    const text = buildSettlementStatementText([campaign({ sellerFeeBasisOverride: null })], now);
    expect(text).toContain(`- 총 거래액: ${GROSS.toLocaleString()}원`);
    expect(computeSettlementPayoutTotals([campaign({ sellerFeeBasisOverride: null })]).hasSellerFeeBasisOverride).toBe(false);
  });
});

describe("발행 전 점검 — 수동 기준액 캠페인에 거짓 경고를 띄우지 않는다", () => {
  const sellerExpenseWarning = (warnings: string[]) => warnings.filter((w) => w.includes("판매 대행비 지출액"));

  it("저장값 = round(기준액 × 요율)이면 경고 없음", () => {
    expect(sellerExpenseWarning(preFlightValidateCampaigns([campaign()]).warnings)).toEqual([]);
  });

  it("음성 대조군: 같은 저장값이라도 기준액이 없으면 총 거래액 기준과 달라 경고가 뜬다", () => {
    expect(
      sellerExpenseWarning(preFlightValidateCampaigns([campaign({ sellerFeeBasisOverride: null })]).warnings),
    ).toHaveLength(1);
  });
});

describe("명세서 — 혼합이 아니면 합계 줄 이름은 「정산 기준액」 그대로", () => {
  it("수동 기준액 캠페인만이면 괄호 설명을 붙이지 않는다", () => {
    const html = buildSettlementStatementHtml([campaign()], now);
    expect(html).not.toContain("캠페인별 기준 합계");
    expect(buildSettlementStatementText([campaign()], now)).toContain(`- 정산 기준액: ${BASIS.toLocaleString()}원`);
  });
});

describe("명세서 — 기준액 표에는 빈 칸·「-」가 없다(판매가·수량 열 자체를 두지 않는다)", () => {
  it.each([
    ["사업자", {}],
    ["개인", individual],
  ] as const)("%s", (_label, extra) => {
    const html = buildSettlementStatementHtml([campaign(extra)], now);
    const table = html.slice(html.indexOf("캠페인별 매출 상세 내역"));
    expect(table).not.toMatch(/>\s*-\s*</);
    expect(table).not.toContain("판매가");
    expect(table).not.toContain(">수량<");
    // 품목명은 앞 3열 폭을 차지한다(나머지 5열 뼈대 유지).
    expect(table).toContain('colspan="3"');
  });
});

describe("명세서 — 저장된 기준액이라도 품목 요율이 섞이면 적용하지 않는다(writer 와 같은 판정)", () => {
  const mixedRates = (extra: Partial<CampaignRow> = {}) =>
    campaign({
      sellerExpense: 1_400_000,
      campaignDeals: [
        { id: "cd-1", campaignId: "campaign-basis", dealId: "d-1", dealName: "옵션 A", quantity: 60, actualSales: 6_000_000, feeRate: 30, sellerMarginRate: 10, sellingPrice: 100_000 },
        { id: "cd-2", campaignId: "campaign-basis", dealId: "d-2", dealName: "옵션 B", quantity: 40, actualSales: 4_000_000, feeRate: 30, sellerMarginRate: 20, sellingPrice: 100_000 },
      ],
      ...extra,
    });

  it("기준액을 찍지 않고 종전(총 거래액) 명세서를 낸다", () => {
    const html = buildSettlementStatementHtml([mixedRates()], now);
    expect(html).not.toContain(BASIS.toLocaleString());
    expect(html).toContain("총 거래액");
    expect(computeSettlementPayoutTotals([mixedRates()]).hasSellerFeeBasisOverride).toBe(false);
    expect(buildSettlementStatementText([mixedRates()], now)).toContain("- 총 거래액:");
  });
});
