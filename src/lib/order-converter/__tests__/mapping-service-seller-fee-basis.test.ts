import { beforeEach, describe, expect, it, vi } from "vitest";

// 수동 정산 기준액(오너 확정 2026-10-06) — 주문 동기화 writer(`recalculateSalesCampaignTotals`)는
// 품목 매출을 갱신해도 **운영자가 정한 기준액을 덮지 않는다.** 판매대행비는 기준액 × 단일 요율로
// 다시 확정된다(`resolveSellerFee`). 금액은 전부 가공이다(P0).

const prismaMock = {
  salesCampaign: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

async function loadMappingService() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  vi.doMock("fs", () => ({ default: { appendFileSync: vi.fn() }, appendFileSync: vi.fn() }));
  return await import("../mapping-service");
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "sc-1",
    status: "ACTIVE",
    sellerTaxType: "INDIVIDUAL",
    operatingExpense: 0,
    miscExpense: 0,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    settlementSales: null,
    sellerExpense: null,
    taxExpense: null,
    sellerFeeBasisOverride: null,
    seller: { agency: null },
    // 주문 동기화가 막 갱신한 품목 매출 — 합계 10,000,000
    campaignDeals: [
      { id: "cd-1", actualSales: 6_000_000, quantity: 60, feeRate: null, sellerMarginRate: null },
      { id: "cd-2", actualSales: 4_000_000, quantity: 40, feeRate: null, sellerMarginRate: null },
    ],
    ...overrides,
  };
}

function written() {
  expect(prismaMock.salesCampaign.update).toHaveBeenCalledTimes(1);
  return prismaMock.salesCampaign.update.mock.calls[0][0].data as Record<string, unknown>;
}

describe("recalculateSalesCampaignTotals — 수동 정산 기준액을 존중한다", () => {
  beforeEach(() => {
    prismaMock.salesCampaign.findUnique.mockReset();
    prismaMock.salesCampaign.update.mockReset();
    prismaMock.salesCampaign.update.mockResolvedValue({});
  });

  it("기준액이 있으면 판매대행비 = round(기준액 × 요율) — 품목 매출이 바뀌어도 기준액을 쓴다", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(makeCampaign({ sellerFeeBasisOverride: 9_600_000 }));
    const { recalculateSalesCampaignTotals } = await loadMappingService();
    await recalculateSalesCampaignTotals("sc-1");

    const data = written();
    expect(data.actualSales).toBe(10_000_000);
    expect(data.sellerExpense).toBe(960_000);
    // 원천세는 그 판매대행비 × 3.3% (31,680) + 수수료 부가세 round(3,000,000 − 3,000,000/1.1)
    expect(data.taxExpense).toBe(31_680 + 272_727);
    // 기준액 컬럼 자체는 이 writer 가 쓰지 않는다(덮어쓰기 0).
    expect(data).not.toHaveProperty("sellerFeeBasisOverride");
  });

  it("기준액이 없으면 종전 품목 합계(개인 = 품목별 공급가액 × 요율)", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(makeCampaign());
    const { recalculateSalesCampaignTotals } = await loadMappingService();
    await recalculateSalesCampaignTotals("sc-1");

    expect(written().sellerExpense).toBe(
      Math.round(Math.round(6_000_000 / 1.1) * 0.1) + Math.round(Math.round(4_000_000 / 1.1) * 0.1),
    );
  });

  it("수동 판매대행비는 기준액보다 우선하고, 수동 0원도 0원 그대로 남는다(truthy 결함 회귀)", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(
      makeCampaign({ sellerFeeBasisOverride: 9_600_000, isManualSellerExpense: true, sellerExpense: 0 }),
    );
    const { recalculateSalesCampaignTotals } = await loadMappingService();
    await recalculateSalesCampaignTotals("sc-1");

    expect(written().sellerExpense).toBe(0);
  });

  it("요율이 다른 품목이 섞인 캠페인은 기준액을 곱하지 않고 자동 합계로 내려간다", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(
      makeCampaign({
        sellerFeeBasisOverride: 9_600_000,
        sellerTaxType: "BUSINESS",
        seller: { agency: { businessNumber: "000-00-00000" } },
        campaignDeals: [
          { id: "cd-1", actualSales: 6_000_000, quantity: 60, feeRate: null, sellerMarginRate: 10 },
          { id: "cd-2", actualSales: 4_000_000, quantity: 40, feeRate: null, sellerMarginRate: 20 },
        ],
      }),
    );
    const { recalculateSalesCampaignTotals } = await loadMappingService();
    await recalculateSalesCampaignTotals("sc-1");

    expect(written().sellerExpense).toBe(600_000 + 800_000);
  });
});
