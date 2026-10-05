import { describe, expect, it, vi, beforeEach } from "vitest";

const findByIdMock = vi.fn();

vi.mock("@/repositories/campaignRepository", () => ({
  campaignRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
  },
}));

import { getCampaignFinancialsTool } from "../campaign-financials";

describe("get_campaign_financials 도구", () => {
  beforeEach(() => {
    findByIdMock.mockReset();
  });

  it("MISSING_PARAM: campaignId가 없으면 되묻기 대상 에러를 반환한다", async () => {
    const result = await getCampaignFinancialsTool.execute({ campaignId: "" as any });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("NOT_FOUND: 캠페인이 존재하지 않으면 NOT_FOUND", async () => {
    findByIdMock.mockResolvedValue(null);
    const result = await getCampaignFinancialsTool.execute({ campaignId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("정상 조회 시 파생 재무값과 입금/지급 플래그를 함께 반환하고, 확정 단정을 하지 않는다", async () => {
    findByIdMock.mockResolvedValue({
      id: "camp1",
      status: "ACTIVE",
      actualSales: 1000000,
      operatingExpense: 0,
      miscExpense: 0,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      sellerTaxType: null,
      isManualSettlementSales: false,
      isManualSellerExpense: false,
      isManualTaxExpense: false,
      settlementSales: null,
      sellerExpense: null,
      taxExpense: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      deal: { dealName: "딜A" },
      seller: { name: "셀러A", agency: null },
    });

    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.campaignId).toBe("camp1");
    expect(result.data.derived).toHaveProperty("settlementSales");
    expect(result.data.derived).toHaveProperty("operatingProfit");
    // 입금 전 상태이므로 확정/지급 플래그는 false여야 한다 (3중 방어).
    expect(result.data.isDepositReceived).toBe(false);
    expect(result.data.isPayoutCompleted).toBe(false);
  });

  it("QUERY_FAILED: repository 예외 시 QUERY_FAILED", async () => {
    findByIdMock.mockRejectedValue(new Error("DB 오류"));
    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });
});

// 수동 정산 기준액(오너 확정 2026-10-06) — 도구도 writer 와 같은 적용 판정을 쓴다. 금액은 가공(P0).
describe("get_campaign_financials — 수동 정산 기준액", () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: "camp1",
    status: "SETTLEMENT_WAIT",
    actualSales: 1_000_000,
    operatingExpense: 0,
    miscExpense: 0,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    sellerTaxType: "BUSINESS",
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    settlementSales: null,
    sellerExpense: null,
    taxExpense: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    deal: { dealName: "딜A" },
    seller: { name: "셀러A", agency: { businessNumber: "000-00-00000" } },
    campaignDeals: [],
    ...overrides,
  });

  beforeEach(() => findByIdMock.mockReset());

  it("적용되는 기준액이면 판매대행비 = round(기준액 × 요율)", async () => {
    findByIdMock.mockResolvedValue(row({ sellerFeeBasisOverride: 800_000 }));
    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.derived.sellerExpense).toBe(80_000);
  });

  it("품목 요율이 섞여 적용되지 않는 기준액은 무시한다(writer 와 같은 판정)", async () => {
    findByIdMock.mockResolvedValue(
      row({ sellerFeeBasisOverride: 800_000, campaignDeals: [{ sellerMarginRate: 10 }, { sellerMarginRate: 20 }] }),
    );
    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.derived.sellerExpense).toBe(100_000);
  });
});
