import { describe, expect, it, vi, beforeEach } from "vitest";
import { calculateDerivedCampaignFinancials } from "@/lib/campaign-financials";
import { SETTLEMENT_AMOUNT_FIELD_LABELS } from "@/lib/settlement-amount-fields";

const findUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ salesCampaign: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } }),
}));

import { getCampaignFinancialsTool } from "../campaign-financials";

// 금액은 전부 가공(P0). 이 도구는 저장값을 그대로 낸다 — 재계산하지 않는다.
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "camp1",
  status: "SETTLEMENT_WAIT",
  actualSales: 1_000_000,
  settlementSales: 300_000,
  sellerExpense: 100_000,
  taxExpense: 20_000,
  operatingExpense: 0,
  miscExpense: 0,
  settlementSupplyCost: 700_000,
  settlementGoodsCost: null,
  operatingProfit: 180_000,
  isManualSettlementSales: false,
  isManualSellerExpense: false,
  isManualTaxExpense: false,
  sellerFeeBasisOverride: null,
  isDepositReceived: false,
  isPayoutCompleted: false,
  deal: { dealName: "딜A" },
  seller: { name: "셀러A" },
  ...overrides,
});

describe("get_campaign_financials 도구", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it("MISSING_PARAM: campaignId가 없으면 되묻기 대상 에러를 반환한다", async () => {
    const result = await getCampaignFinancialsTool.execute({ campaignId: "" as any });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("NOT_FOUND: 캠페인이 존재하지 않으면 NOT_FOUND", async () => {
    findUniqueMock.mockResolvedValue(null);
    const result = await getCampaignFinancialsTool.execute({ campaignId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: DB 예외 시 QUERY_FAILED", async () => {
    findUniqueMock.mockRejectedValue(new Error("DB 오류"));
    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });

  it.each([
    ["Prisma 원시 쿼리 모양", Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: "42501" } })],
    ["드라이버 문구만", new Error('permission denied for table "SalesCampaign"')],
  ])("권한 거부(42501)는 감싸지 않고 그대로 던진다 — 봇이 재시도 불가로 판정해야 한다 (%s)", async (_label, error) => {
    findUniqueMock.mockRejectedValue(error);
    await expect(getCampaignFinancialsTool.execute({ campaignId: "camp1" })).rejects.toBe(error);
  });

  it("조회 칸은 워커 role GRANT 범위 안이다 — CampaignDeal·Partner(agency)를 읽지 않는다", async () => {
    findUniqueMock.mockResolvedValue(row());
    await getCampaignFinancialsTool.execute({ campaignId: "camp1" });

    const args = findUniqueMock.mock.calls[0][0] as { where: unknown; select: Record<string, unknown>; include?: unknown };
    expect(args.where).toEqual({ id: "camp1" });
    expect(args.include).toBeUndefined();
    for (const forbidden of ["campaignDeals", "agency", "totalMarginRate", "sellerMarginRate"]) {
      expect(JSON.stringify(args.select)).not.toContain(forbidden);
    }
  });

  it("다품목 캠페인: 캠페인 요율 재계산값이 아니라 저장된 금액을 낸다", async () => {
    // writer 가 품목 루프로 확정해 저장한 값과, 캠페인 단위 요율 하나로 다시 계산한 값이 다른 사례.
    const stored = row({
      actualSales: 40_000_000,
      settlementSales: 9_876_500,
      sellerExpense: 3_210_000,
      taxExpense: 606_045,
      operatingProfit: 6_060_455,
      settlementSupplyCost: 35_910_000,
      settlementGoodsCost: 0,
    });
    const naive = calculateDerivedCampaignFinancials({
      actualSales: 40_000_000,
      operatingExpense: 0,
      miscExpense: 0,
      totalMarginRate: 25,
      sellerMarginRate: 10,
    });
    // 전제 확인 — 「저장값 ≠ 단순 재계산」 사례여야 이 테스트가 의미가 있다.
    expect(naive.settlementSales).not.toBe(stored.settlementSales);
    findUniqueMock.mockResolvedValue(stored);

    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toMatchObject({
      source: "stored",
      campaignId: "camp1",
      dealName: "딜A",
      sellerName: "셀러A",
      actualSales: 40_000_000,
      settlementSales: 9_876_500,
      sellerExpense: 3_210_000,
      taxExpense: 606_045,
      settlementSupplyCost: 35_910_000,
      settlementGoodsCost: 0,
      operatingProfit: 6_060_455,
      operatingProfitSource: "stored",
      isDepositReceived: false,
      isPayoutCompleted: false,
    });
    expect(result.data).not.toHaveProperty("derived");
    expect(result.evidence.dataSources).toEqual(["SalesCampaign", "Deal", "Seller"]);
  });

  it("비어 있는 칸은 null 로(0 과 구분), 저장 영업이익이 없으면 재무 카드와 같은 폴백으로 계산한다", async () => {
    findUniqueMock.mockResolvedValue(
      row({
        operatingExpense: null,
        miscExpense: 5_000,
        settlementSupplyCost: null,
        settlementGoodsCost: 0,
        operatingProfit: null,
        isManualSellerExpense: true,
        sellerFeeBasisOverride: 800_000,
      }),
    );

    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.operatingExpense).toBeNull();
    expect(result.data.settlementSupplyCost).toBeNull();
    expect(result.data.settlementGoodsCost).toBe(0);
    expect(result.data.operatingProfit).toBe(300_000 - 100_000 - 20_000 - 0 - 5_000);
    expect(result.data.operatingProfitSource).toBe("computed_from_stored");
    expect(result.data).toMatchObject({ isManualSellerExpense: true, isManualSettlementSales: false, sellerFeeBasisOverride: 800_000 });
  });

  it("Decimal 같은 숫자 객체도 number 로 통과시킨다(값 변환만, 산술 없음)", async () => {
    const decimal = (value: number) => ({ valueOf: () => value, toString: () => String(value) });
    findUniqueMock.mockResolvedValue(row({ settlementGoodsCost: decimal(12_345), sellerFeeBasisOverride: decimal(800_000) }));

    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.settlementGoodsCost).toBe(12_345);
    expect(result.data.sellerFeeBasisOverride).toBe(800_000);
  });

  it("정산 금액 수정 기안이 고칠 수 있는 칸을 빠짐없이 낸다", async () => {
    findUniqueMock.mockResolvedValue(row());
    const result = await getCampaignFinancialsTool.execute({ campaignId: "camp1" });
    if (!result.ok) throw new Error("expected ok");
    for (const field of Object.keys(SETTLEMENT_AMOUNT_FIELD_LABELS)) {
      expect(result.data).toHaveProperty(field);
    }
  });

  it("모델에게 주는 설명은 재계산·파생치가 아니라 저장된 금액이라고 말한다", () => {
    expect(getCampaignFinancialsTool.description).toContain("저장된 정산 금액");
    expect(getCampaignFinancialsTool.description).not.toMatch(/파생|계산해 반환/);
  });
});
