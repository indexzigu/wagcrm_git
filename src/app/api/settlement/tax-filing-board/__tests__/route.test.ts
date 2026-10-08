// 이 라우트는 한 응답에 **서로 다른 시간 축** 두 개를 싣는다.
// 세금계산서 = 캠페인 상태 축(월 무관) · 원천징수 = 지급월 축.
// 두 축이 다시 한 필터를 공유하면 2026-08-09 에 고친 버그가 그대로 재발한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const checklistFindMany = vi.fn();
const loadInvoiceProgress = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany, count: vi.fn().mockResolvedValue(0) },
    campaignChecklistItem: { findMany: checklistFindMany },
    taxFilingLog: { findMany: vi.fn().mockResolvedValue([]) },
    activityLog: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));
vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: { loadInvoiceProgress: (...a: unknown[]) => loadInvoiceProgress(...a) },
}));
// 캠페인 행 변환은 이 라우트의 관심사가 아니다 — 쿼리 결과를 그대로 CampaignRow 로 쓴다.
vi.mock("@/lib/campaign-row", () => ({ toCampaignRow: (row: unknown) => row }));

describe("tax-filing-board 라우트 — 두 축이 분리돼 있다", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
    checklistFindMany.mockReset();
    checklistFindMany.mockResolvedValue([]);
    loadInvoiceProgress.mockReset();
    loadInvoiceProgress.mockResolvedValue(new Map());
  });

  it("세금계산서 쿼리는 status 로 거르고 payoutCompletedAt 을 쓰지 않는다", async () => {
    const { GET } = await import("../route");
    await GET(new Request("http://x/api/settlement/tax-filing-board?month=2026-08"));

    const invoiceQuery = findMany.mock.calls
      .map(([arg]) => arg)
      .find((arg) => JSON.stringify(arg?.where ?? {}).includes("status"));

    expect(invoiceQuery).toBeDefined();
    expect(JSON.stringify(invoiceQuery.where)).not.toContain("payoutCompletedAt");
  });

  it("원천징수 쿼리는 payoutCompletedAt 축을 그대로 쓴다", async () => {
    const { GET } = await import("../route");
    await GET(new Request("http://x/api/settlement/tax-filing-board?month=2026-08"));

    const withholdingQuery = findMany.mock.calls
      .map(([arg]) => arg)
      .find((arg) => JSON.stringify(arg?.where ?? {}).includes("payoutCompletedAt"));

    expect(withholdingQuery).toBeDefined();
  });
});

describe("tax-filing-board 라우트 — 월정산 공급사 행 (T-244)", () => {
  const MONTHLY = {
    id: "m1",
    dealName: "딜M",
    campaignName: "딜M - 셀러M 1차",
    partnerName: "공급사M",
    partnerBusinessNumber: "1231231231",
    partnerCeoName: "대표M",
    partnerMonthlySettlement: true,
    sellerId: "s1",
    sellerName: "셀러M",
    salesChannel: "BRAND_MALL",
    status: "SETTLEMENT_IN_PROGRESS",
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "셀러상사",
    sellerCompanyCeoName: "대표S",
    sellerCompanyBusinessNumber: "1234567890",
    settlementSales: 5_500_000,
    sellerExpense: 2_200_000,
    actualSales: 11_000_000,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    groupId: null,
  };

  beforeEach(() => {
    findMany.mockReset();
    findMany.mockImplementation(async (arg: { where?: Record<string, unknown> }) =>
      JSON.stringify(arg?.where ?? {}).includes("status") ? [MONTHLY] : [],
    );
    checklistFindMany.mockReset();
    checklistFindMany.mockResolvedValue([
      { id: "i-supplier", campaignId: "m1", label: "공급사 총 수수료 매출 세금계산서 발행" },
      { id: "i-seller", campaignId: "m1", label: "셀러 판매대행 수수료 세금계산서 수취" },
    ]);
    loadInvoiceProgress.mockReset();
    loadInvoiceProgress.mockResolvedValue(new Map([["m1", { done: 1, total: 2, openMonths: ["2026-10"] }]]));
  });

  it("월정산 캠페인만 골라 진행을 묻고, 공급사 행에는 진행을 싣고 「완료」 앵커를 비운다", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("http://x/api/settlement/tax-filing-board?month=2026-10"));
    const body = (await res.json()) as { rows: Array<{ sourceField: string; monthlyInvoice: unknown; checklistItemId: string | null }> };

    expect(loadInvoiceProgress).toHaveBeenCalledWith(expect.anything(), ["m1"]);
    const supplier = body.rows.find((row) => row.sourceField === "supplierInvoiceIssuedAt");
    const seller = body.rows.find((row) => row.sourceField === "sellerInvoiceIssuedAt");
    expect(supplier).toMatchObject({ monthlyInvoice: { done: 1, total: 2 }, checklistItemId: null });
    // 셀러 의무는 달별 계산서와 무관하다 — 종전대로 「완료」 앵커가 붙는다(음성 대조군).
    expect(seller).toMatchObject({ monthlyInvoice: null, checklistItemId: "i-seller" });
  });
});
