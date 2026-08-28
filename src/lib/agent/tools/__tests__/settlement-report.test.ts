import { describe, expect, it, vi, beforeEach } from "vitest";

const getSettlementReportMock = vi.fn();
const findCampaignsForReportMock = vi.fn();

vi.mock("@/services/settlementService", () => ({
  SettlementService: {
    getSettlementReport: (...args: unknown[]) => getSettlementReportMock(...args),
  },
}));

vi.mock("@/repositories/settlementRepository", () => ({
  SettlementRepository: {
    findCampaignsForReport: (...args: unknown[]) => findCampaignsForReportMock(...args),
  },
}));

import { getSettlementReportTool, deriveSettlementState } from "../settlement-report";

describe("deriveSettlementState — 예정/확정/지급 3중 방어 ①", () => {
  // 판정 축이 채널 슬롯이라 `salesChannel` 이 필수 입력이다(자사몰 회귀 단언은
  // `src/lib/__tests__/settlement-status.test.ts` 소관 — 여기는 도구 계약만 본다).
  const flags = (deposit: boolean, payout: boolean) => ({
    salesChannel: "BRAND_MALL",
    isDepositReceived: deposit,
    isPayoutCompleted: payout,
    isSupplierPayoutCompleted: false,
  });

  it("입금 전이면 pending(예정)", () => {
    expect(deriveSettlementState(flags(false, false))).toBe("pending");
  });

  it("입금됐지만 지급 전이면 confirmed(확정)", () => {
    expect(deriveSettlementState(flags(true, false))).toBe("confirmed");
  });

  it("지급 완료면 paid(지급완료) — isDepositReceived 값과 무관", () => {
    expect(deriveSettlementState(flags(true, true))).toBe("paid");
    expect(deriveSettlementState(flags(false, true))).toBe("paid");
  });
});

describe("get_settlement_report 도구", () => {
  beforeEach(() => {
    getSettlementReportMock.mockReset();
    findCampaignsForReportMock.mockReset();
  });

  it("화면과 동일한 summary 수치를 반환한다 (SettlementService 위임)", async () => {
    getSettlementReportMock.mockResolvedValue({
      month: "2026-07",
      summary: { totalRevenue: 1000000, totalMargin: 200000, totalSellerPayouts: 300000, campaignCount: 1 },
      campaigns: [
        {
          id: "camp1",
          dealName: "딜A",
          brandName: "브랜드A",
          sellerName: "셀러A",
          actualSales: 1000000,
          sellerPayoutAmount: 300000,
          netMarginAmount: 200000,
        },
      ],
    });
    findCampaignsForReportMock.mockResolvedValue([
      {
        id: "camp1",
        isDepositReceived: true,
        isPayoutCompleted: false,
        depositReceivedAt: new Date("2026-07-10T00:00:00Z"),
        payoutCompletedAt: null,
      },
    ]);

    const result = await getSettlementReportTool.execute({ month: "2026-07" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.summary.totalRevenue).toBe(1000000);
    expect(result.data.campaigns[0].state).toBe("confirmed");
    expect(result.data.stateCounts).toEqual({ pending: 0, confirmed: 1, paid: 0 });
    expect(result.evidence.dataSources).toContain("SalesCampaign");
  });

  it("MISSING_PARAM: month 형식이 잘못되면 되묻기 대상 에러를 반환한다", async () => {
    const result = await getSettlementReportTool.execute({ month: "2026/07" as any });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("NOT_FOUND: 조건에 맞는 캠페인이 없으면 NOT_FOUND를 반환한다", async () => {
    getSettlementReportMock.mockResolvedValue({
      month: "2026-07",
      summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0, campaignCount: 0 },
      campaigns: [],
    });

    const result = await getSettlementReportTool.execute({ month: "2026-07" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: 서비스 조회 중 예외가 발생하면 QUERY_FAILED를 반환한다", async () => {
    getSettlementReportMock.mockRejectedValue(new Error("DB 연결 실패"));

    const result = await getSettlementReportTool.execute({ month: "2026-07" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("QUERY_FAILED");
  });

  it("셀러 이름 필터가 searchQuery로 전달된다", async () => {
    getSettlementReportMock.mockResolvedValue({
      month: "2026-07",
      summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0, campaignCount: 1 },
      campaigns: [
        {
          id: "camp1",
          dealName: "딜A",
          brandName: null,
          sellerName: "테스트셀러",
          actualSales: 0,
          sellerPayoutAmount: 0,
          netMarginAmount: 0,
        },
      ],
    });
    findCampaignsForReportMock.mockResolvedValue([
      { id: "camp1", isDepositReceived: false, isPayoutCompleted: false, depositReceivedAt: null, payoutCompletedAt: null },
    ]);

    await getSettlementReportTool.execute({ month: "2026-07", sellerName: "테스트셀러" });

    expect(getSettlementReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ searchQuery: "테스트셀러" })
    );
  });

  it("m5: rawCampaigns에서 매칭되지 않는 캠페인이 있으면 mergeMisses가 카운트되고 경고 로그를 남긴다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getSettlementReportMock.mockResolvedValue({
      month: "2026-07",
      summary: { totalRevenue: 500000, totalMargin: 100000, totalSellerPayouts: 150000, campaignCount: 2 },
      campaigns: [
        {
          id: "camp1",
          dealName: "딜A",
          brandName: null,
          sellerName: "셀러A",
          actualSales: 500000,
          sellerPayoutAmount: 150000,
          netMarginAmount: 100000,
        },
        {
          id: "camp-missing",
          dealName: "딜B",
          brandName: null,
          sellerName: "셀러B",
          actualSales: 0,
          sellerPayoutAmount: 0,
          netMarginAmount: 0,
        },
      ],
    });
    // rawCampaigns에는 camp1만 있고 camp-missing은 없다 — 병합 miss 상황.
    findCampaignsForReportMock.mockResolvedValue([
      { id: "camp1", isDepositReceived: true, isPayoutCompleted: false, depositReceivedAt: new Date(), payoutCompletedAt: null },
    ]);

    const result = await getSettlementReportTool.execute({ month: "2026-07" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.evidence.query).toMatchObject({ mergeMisses: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
