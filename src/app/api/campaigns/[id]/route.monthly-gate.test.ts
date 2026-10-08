import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";

// 캠페인 PATCH 의 월별 정산 완료 게이트(T-240) — 월정산 거래처 캠페인은 모든 월 줄 체크가 끝나야
// 정산 완료다. 수동 상태 변경은 409 로 거절하고(아무것도 쓰지 않는다), 플래그 토글이 부른 자동 전이는
// 플래그만 저장하고 상태를 보류한다. 하네스는 route.seller-fee-basis.test.ts 와 같다. 금액은 가공이다(P0).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((callback: () => unknown) => callback()) };
});

const findUniqueMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const txUpdateMock = vi.fn();
const txDealFindManyMock = vi.fn();
const recordActivityMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      findUniqueOrThrow: (...args: unknown[]) => findUniqueOrThrowMock(...args),
      update: vi.fn(),
    },
    salesTask: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        salesCampaign: { update: (...args: unknown[]) => txUpdateMock(...args) },
        campaignDeal: { findMany: (...args: unknown[]) => txDealFindManyMock(...args) },
      }),
  }),
}));
vi.mock("@/lib/campaign-activity", () => ({
  describeChangedFields: (fields: string[]) => fields.join(", "),
  recordCampaignActivity: (...args: unknown[]) => recordActivityMock(...args),
}));
vi.mock("@/lib/campaign-checklist", () => ({ ensureCampaignChecklistForStatus: vi.fn() }));
vi.mock("@/lib/campaign-row", () => ({
  toCampaignRow: (row: { id: string }) => ({ id: row.id }),
  toKstDateStr: (value: Date | null) => value?.toISOString().slice(0, 10) ?? null,
}));
vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "user-1", email: "owner@example.com", role: "admin" }),
}));
vi.mock("@/lib/user-registry", () => ({ getCrmUsers: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/cache-tags", () => ({ revalidateCampaignCaches: vi.fn() }));
vi.mock("@/lib/google-calendar-sync", () => ({ syncCampaignToCalendar: vi.fn().mockResolvedValue({ ok: true }) }));
const completionBlockerMock = vi.fn();
vi.mock("@/services/monthlySettlementService", () => ({
  monthlySettlementService: {
    findCompletionBlocker: (...args: unknown[]) => completionBlockerMock(...args),
    findCompletionBlockers: vi.fn().mockResolvedValue(new Map()),
  },
}));

type Deal = { id: string; dealId: string; actualSales: number; sellerMarginRate: number | null; feeRate: number | null };

function previous(overrides: Record<string, unknown> = {}, deals: Deal[] = SAME_RATE_DEALS) {
  return {
    id: "c1",
    status: "SETTLEMENT_WAIT",
    salesChannel: "BRAND_MALL",
    dealId: "deal-1",
    sellerId: "seller-1",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-15T00:00:00.000Z"),
    returnPeriodEndDate: null,
    roundNumber: 1,
    campaignName: "딜 - 셀러",
    groupId: null,
    group: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    actualSales: 10_000_000,
    operatingExpense: 0,
    miscExpense: 0,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    isManualMargin: false,
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    settlementSales: 3_000_000,
    sellerExpense: 1_000_000,
    taxExpense: 0,
    sellerFeeBasisOverride: null,
    sellerTaxType: "BUSINESS",
    assignedTo: null,
    notesFromImport: null,
    seller: { alias: "셀러", name: "셀러", agency: { businessNumber: "000-00-00000" } },
    campaignDeals: deals,
    ...overrides,
  };
}

const SAME_RATE_DEALS: Deal[] = [
  { id: "cd-1", dealId: "d-1", actualSales: 6_000_000, sellerMarginRate: null, feeRate: null },
  { id: "cd-2", dealId: "d-2", actualSales: 4_000_000, sellerMarginRate: 10, feeRate: null },
];

async function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/campaigns/c1", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
}

const BLOCKED = "월별 정산 중 10월분(1/4)이 끝나지 않아 정산 완료로 바꿀 수 없습니다.";

beforeEach(() => {
  [findUniqueMock, findUniqueOrThrowMock, txUpdateMock, txDealFindManyMock, recordActivityMock, completionBlockerMock].forEach(
    (m) => m.mockReset(),
  );
  txUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c1", group: null, ...data }));
  findUniqueOrThrowMock.mockResolvedValue({ id: "c1" });
  txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);
});

describe("PATCH — 월별 정산 완료 게이트(T-240)", () => {
  it("수동으로 정산 완료를 고르면 409 + 남은 달 사유, 아무것도 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous({ status: "SETTLEMENT_IN_PROGRESS" }));
    completionBlockerMock.mockResolvedValue(BLOCKED);

    const response = await patch({ status: "COMPLETED" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: BLOCKED });
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("입금·지급이 다 차도 체크가 남았으면 플래그만 저장하고 상태는 그대로 둔다", async () => {
    findUniqueMock.mockResolvedValue(
      previous({ status: "SETTLEMENT_IN_PROGRESS", isDepositReceived: true, isPayoutCompleted: false }),
    );
    completionBlockerMock.mockResolvedValue(BLOCKED);

    const response = await patch({ isPayoutCompleted: true });
    expect(response.status).toBe(200);
    const data = txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.isPayoutCompleted).toBe(true);
    expect(data.status).toBeUndefined();
    // 보류 사유는 응답의 일회성 신호로 화면에 간다(정산 카드가 경고 토스트로 알린다).
    expect((await response.json()).monthlyCompletionBlocked).toBe(BLOCKED);
  });

  it("월 줄이 모두 끝났으면(게이트 통과) 종전처럼 정산 완료로 넘어간다", async () => {
    findUniqueMock.mockResolvedValue(
      previous({ status: "SETTLEMENT_IN_PROGRESS", isDepositReceived: true, isPayoutCompleted: false }),
    );
    completionBlockerMock.mockResolvedValue(null);

    await patch({ isPayoutCompleted: true });
    const data = txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("COMPLETED");
  });

  it("정산 완료가 아닌 상태 변경에는 게이트를 부르지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous({ status: "SETTLEMENT_WAIT" }));
    await patch({ status: "SETTLEMENT_IN_PROGRESS" });
    expect(completionBlockerMock).not.toHaveBeenCalled();
  });
});
