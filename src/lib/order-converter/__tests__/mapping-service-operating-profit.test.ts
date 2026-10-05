import { beforeEach, describe, expect, it, vi } from "vitest";

// 회귀(오너 확정 2026-10-05): 주문 동기화 writer(`recalculateSalesCampaignTotals`)가 저장하는
// `operatingProfit` 은 **영업수익(settlementSales) 기준**이다. 종전에는 피감수가 총매출
// (`actualSales`)이라, 총매출 ≠ 영업수익인 캠페인에서 편집 경로와 다른(부풀려진) 손익이 저장됐다.
//
// 이름·금액은 전부 가공이다(P0: 추적 파일에 실명·실측치 금지).

const prismaMock = {
  salesCampaign: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

async function loadMappingService() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  // 디버그 로그 파일 쓰기는 no-op 처리(워크트리에 mapping-debug.log 생성 방지).
  vi.doMock("fs", () => ({ default: { appendFileSync: vi.fn() }, appendFileSync: vi.fn() }));
  return await import("../mapping-service");
}

type CampaignOverrides = Record<string, unknown>;

function makeCampaign(overrides: CampaignOverrides = {}) {
  return {
    id: "sc-1",
    status: "ACTIVE",
    salesChannel: "OUR_MALL",
    sellerTaxType: "BUSINESS",
    operatingExpense: 5_000,
    miscExpense: 1_000,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    settlementSales: null,
    sellerExpense: null,
    taxExpense: null,
    seller: { agency: { businessNumber: "000-00-00000" } },
    campaignDeals: [
      { id: "cd-1", actualSales: 600_000, quantity: 6, feeRate: null, sellerMarginRate: null },
      { id: "cd-2", actualSales: 400_000, quantity: 4, feeRate: null, sellerMarginRate: null },
    ],
    ...overrides,
  };
}

function writtenData() {
  expect(prismaMock.salesCampaign.update).toHaveBeenCalledTimes(1);
  return prismaMock.salesCampaign.update.mock.calls[0][0].data as {
    actualSales: number;
    settlementSales: number;
    sellerExpense: number;
    taxExpense: number;
    operatingProfit: number;
  };
}

describe("recalculateSalesCampaignTotals — 저장 operatingProfit 은 영업수익 기준", () => {
  beforeEach(() => {
    prismaMock.salesCampaign.findUnique.mockReset();
    prismaMock.salesCampaign.update.mockReset();
    prismaMock.salesCampaign.update.mockResolvedValue({});
  });

  it("사업자 셀러: 총매출이 아니라 영업수익에서 비용을 뺀다", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(makeCampaign());
    const { recalculateSalesCampaignTotals } = await loadMappingService();

    await recalculateSalesCampaignTotals("sc-1");

    const data = writtenData();
    // 픽스처 전제 — 총매출과 영업수익이 달라야 두 기준이 갈린다.
    expect(data.actualSales).toBe(1_000_000);
    expect(data.settlementSales).toBe(300_000);
    expect(data.actualSales).not.toBe(data.settlementSales);

    expect(data.operatingProfit).toBe(
      data.settlementSales - data.sellerExpense - data.taxExpense - 5_000 - 1_000,
    );
    // 300,000 − 100,000 − 18,182(순수수료의 부가세분) − 5,000 − 1,000
    expect(data.operatingProfit).toBe(175_818);
  });

  it("개인 셀러: 같은 기준이다(세금 항이 달라도 피감수는 영업수익)", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(
      makeCampaign({ sellerTaxType: "INDIVIDUAL", seller: { agency: null } }),
    );
    const { recalculateSalesCampaignTotals } = await loadMappingService();

    await recalculateSalesCampaignTotals("sc-1");

    const data = writtenData();
    expect(data.actualSales).not.toBe(data.settlementSales);
    expect(data.operatingProfit).toBe(
      data.settlementSales - data.sellerExpense - data.taxExpense - 5_000 - 1_000,
    );
    expect(data.operatingProfit).toBeLessThan(data.settlementSales);
  });

  it("수동 입력된 영업수익·판매대행비·세금도 같은 식으로 뺀다", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(
      makeCampaign({
        isManualSettlementSales: true,
        isManualSellerExpense: true,
        isManualTaxExpense: true,
        settlementSales: 250_000,
        sellerExpense: 80_000,
        taxExpense: 15_000,
      }),
    );
    const { recalculateSalesCampaignTotals } = await loadMappingService();

    await recalculateSalesCampaignTotals("sc-1");

    const data = writtenData();
    expect(data.settlementSales).toBe(250_000);
    expect(data.operatingProfit).toBe(250_000 - 80_000 - 15_000 - 5_000 - 1_000);
  });

  it("정산 락 상태면 쓰지 않는다(기존 값 보존)", async () => {
    prismaMock.salesCampaign.findUnique.mockResolvedValue(makeCampaign({ status: "COMPLETED" }));
    const { recalculateSalesCampaignTotals } = await loadMappingService();

    await recalculateSalesCampaignTotals("sc-1");

    expect(prismaMock.salesCampaign.update).not.toHaveBeenCalled();
  });
});
