import { describe, expect, it } from "vitest";

import { toCampaignRow } from "../campaign-row";

function createCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "campaign-1",
    dealId: "deal-main",
    sellerId: "seller-1",
    campaignName: "오메가3 - 별하샵 미르",
    salesCode: null,
    updatedAt: new Date("2026-06-25T00:00:00Z"),
    startDate: new Date("2026-06-23T00:00:00Z"),
    endDate: new Date("2026-06-30T00:00:00Z"),
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 0,
    totalMarginRate: 40,
    sellerMarginRate: 25,
    netMarginRate: 15,
    status: "ACTIVE",
    isManualMargin: false,
    deal: {
      dealName: "오메가3",
      costPrice: 0,
      sellingPrice: 30900,
      brandName: "센토메가",
      partner: { name: "센토메가" },
    },
    seller: {
      name: "별하샵 미르",
      alias: "별하샵 미르",
      snsType: "INSTAGRAM",
      snsHandle: "berry_market",
    },
    campaignDeals: [],
    ...overrides,
  };
}

describe("toCampaignRow", () => {
  it("그룹 캠페인은 정산 및 계산서 메타데이터를 CampaignGroup에서 읽는다", () => {
    const row = toCampaignRow(createCampaign({
      groupId: "group-1",
      isDepositReceived: false,
      isPayoutCompleted: false,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      expectedDepositDate: new Date("2026-07-10T00:00:00Z"),
      expectedPayoutDate: null,
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
      accountingCompletedAt: null,
      notesFromImport: '{"approvalNumber":"legacy"}',
      group: {
        isDepositReceived: true,
        isPayoutCompleted: true,
        depositReceivedAt: new Date("2026-07-12T00:00:00Z"),
        payoutCompletedAt: new Date("2026-07-13T00:00:00Z"),
        expectedDepositDate: new Date("2026-07-14T00:00:00Z"),
        expectedPayoutDate: new Date("2026-07-15T00:00:00Z"),
        supplierInvoiceIssuedAt: new Date("2026-07-16T00:00:00Z"),
        sellerInvoiceIssuedAt: new Date("2026-07-17T00:00:00Z"),
        accountingCompletedAt: new Date("2026-07-18T00:00:00Z"),
        invoiceInfo: '{"approvalNumber":"group"}',
      },
    }));

    expect(row).toMatchObject({
      isDepositReceived: true,
      isPayoutCompleted: true,
      depositReceivedAt: "2026-07-12",
      payoutCompletedAt: "2026-07-13",
      expectedDepositDate: "2026-07-14",
      expectedPayoutDate: "2026-07-15",
      supplierInvoiceIssuedAt: "2026-07-16",
      sellerInvoiceIssuedAt: "2026-07-17",
      accountingCompletedAt: "2026-07-18",
      notesFromImport: '{"approvalNumber":"group"}',
    });
  });

  it("그룹 캠페인의 정산 예정일은 그룹이 정본이다 — 그룹 값 null이면 null(무폴백)", () => {
    // 근본수정 방향: 예정일 승계는 campaignGroupService.createGroup + 백필이 담당하고,
    // 렌더 계층(toCampaignRow)은 그룹-정본 의미론을 유지한다. read 시점 멤버 폴백은
    // "미설정 virgin"과 "오너의 명시적 삭제"를 구분 못 해 지운 값을 되살리므로 쓰지 않는다.
    const row = toCampaignRow(createCampaign({
      groupId: "group-1",
      // 캠페인 스칼라(그룹핑 시점에 얼어붙은 stale 값) — 폴백되면 안 된다.
      expectedDepositDate: new Date("2026-07-10T00:00:00Z"),
      expectedPayoutDate: new Date("2026-07-20T00:00:00Z"),
      group: {
        isDepositReceived: false,
        isPayoutCompleted: false,
        depositReceivedAt: null,
        payoutCompletedAt: null,
        // 오너가 그룹 예정일을 명시적으로 지운 상태(null).
        expectedDepositDate: null,
        expectedPayoutDate: null,
        supplierInvoiceIssuedAt: null,
        sellerInvoiceIssuedAt: null,
        accountingCompletedAt: null,
        invoiceInfo: null,
      },
    }));

    // 그룹이 정본 — 지운 값이 캠페인 스칼라로 되살아나지 않는다.
    expect(row.expectedDepositDate).toBeNull();
    expect(row.expectedPayoutDate).toBeNull();
  });

  it("hydrates base deal financial fields when CampaignDeal snapshot values are empty", () => {
    const row = toCampaignRow(
      createCampaign({
        campaignDeals: [
          {
            id: "campaign-deal-1",
            campaignId: "campaign-1",
            dealId: "deal-main",
            quantity: 0,
            actualSales: 0,
            feeRate: 0,
            sellerMarginRate: 25,
            costPrice: null,
            sellingPrice: 0,
            deal: {
              dealName: "오메가3",
              unit: "박스",
              unitQuantity: 1,
              supplementaryInfo: "1개월분",
              costPrice: 18540,
              sellingPrice: 30900,
              totalCommissionRate: 40,
            },
          },
        ],
      }) as Parameters<typeof toCampaignRow>[0],
    );

    expect(row.campaignDeals).toHaveLength(1);
    expect(row.campaignDeals?.[0]).toMatchObject({
      dealName: "오메가3 - 1박스 (1개월분)",
      sellingPrice: 30900,
      costPrice: 18540,
      feeRate: 40,
      sellerMarginRate: 25,
    });
  });

  it("keeps the stored option name intact when the relation uses parentDealId", () => {
    const row = toCampaignRow(
      createCampaign({
        campaignDeals: [
          {
            id: "campaign-deal-option-1",
            campaignId: "campaign-1",
            dealId: "deal-option-1",
            quantity: 1,
            actualSales: 0,
            feeRate: 0,
            sellerMarginRate: 25,
            costPrice: 18540,
            sellingPrice: 30900,
            deal: {
              dealName: "듀얼 올레올렛샷 - 2박스 (혼합 40포)",
              parentDealId: "deal-main",
              unit: "박스",
              unitQuantity: 2,
              supplementaryInfo: JSON.stringify({ supplementaryInfo: "혼합 40포" }),
              costPrice: 18540,
              sellingPrice: 30900,
              totalCommissionRate: 40,
            },
          },
        ],
      }) as Parameters<typeof toCampaignRow>[0],
    );

    expect(row.campaignDeals?.[0]?.dealName).toBe("듀얼 올레올렛샷 - 2박스 (혼합 40포)");
  });

  describe("최저가 위반 요약 (UX1-C)", () => {
    it("violationSummary가 주어지지 않으면 hasPriceViolation은 false다 (회귀 금지)", () => {
      const row = toCampaignRow(createCampaign());
      expect(row.hasPriceViolation).toBe(false);
      expect(row.violatedDealCount).toBe(0);
    });

    it("violationSummaryByCampaignId에 이 캠페인 항목이 있으면 hasPriceViolation=true, violatedDealCount를 그대로 반영한다", () => {
      const violationSummaryByCampaignId = new Map([
        ["campaign-1", { violatedDealCount: 2 }],
      ]);

      const row = toCampaignRow(
        createCampaign(),
        violationSummaryByCampaignId as Parameters<typeof toCampaignRow>[1],
      );

      expect(row.hasPriceViolation).toBe(true);
      expect(row.violatedDealCount).toBe(2);
    });

    it("violationSummaryByCampaignId에 이 캠페인 항목이 없으면 hasPriceViolation은 false다", () => {
      const violationSummaryByCampaignId = new Map([
        ["other-campaign", { violatedDealCount: 5 }],
      ]);

      const row = toCampaignRow(
        createCampaign(),
        violationSummaryByCampaignId as Parameters<typeof toCampaignRow>[1],
      );

      expect(row.hasPriceViolation).toBe(false);
      expect(row.violatedDealCount).toBe(0);
    });
  });
});
