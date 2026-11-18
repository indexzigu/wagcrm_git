import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";
import { isCampaignPeriodUnset } from "@/lib/campaign-period";

// T-313 Part A — a campaign whose period is not set yet ("기간 미정", isCampaignPeriodUnset) cannot
// move to any status other than PROPOSAL/PREPARATION/DROPPED until the owner enters dates, whatever
// its previous status (kanban moves are any→any). The guard lives in
// campaignPatchService (screen PATCH and agent update_record share it). Harness copied from
// route.monthly-gate.test.ts. Values are fabricated (P0).

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
    campaignNote: { create: vi.fn().mockResolvedValue({}) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        salesCampaign: {
          update: (...args: unknown[]) => txUpdateMock(...args),
          // Link-expiry resync reads stored dates after a period change.
          findMany: vi.fn().mockResolvedValue([]),
        },
        campaignDeal: { findMany: (...args: unknown[]) => txDealFindManyMock(...args) },
        trackedLink: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
const legacyDateBlockerMock = vi.fn();
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: {
    findCompletionBlocker: (...args: unknown[]) => completionBlockerMock(...args),
    // 실제 게이트 모양을 재현한다 — 「정산 완료 자동 전이 + 이전 상태가 완료 아님」일 때만 판정을 묻는다.
    gateAutoCompletion: async (_db: unknown, id: string, prev: string, auto: string | null | undefined) => {
      if (auto !== "COMPLETED" || prev === "COMPLETED") return { status: auto ?? undefined, blockedReason: null };
      const blockedReason = (await completionBlockerMock(_db, id)) as string | null;
      return { status: blockedReason ? undefined : auto, blockedReason };
    },
    findCompletionBlockers: vi.fn().mockResolvedValue(new Map()),
    findLegacyDateWriteBlocker: (...args: unknown[]) => legacyDateBlockerMock(...args),
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


beforeEach(() => {
  [
    findUniqueMock,
    findUniqueOrThrowMock,
    txUpdateMock,
    txDealFindManyMock,
    recordActivityMock,
    completionBlockerMock,
    legacyDateBlockerMock,
  ].forEach((m) => m.mockReset());
  legacyDateBlockerMock.mockResolvedValue(null);
  txUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c1", group: null, ...data }));
  findUniqueOrThrowMock.mockResolvedValue({ id: "c1" });
  txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);
});

const PLACEHOLDER = new Date("2026-11-17T03:00:00.000Z");
const UNSET = { status: "PREPARATION", startDate: PLACEHOLDER, endDate: PLACEHOLDER, periodPlaceholderAt: PLACEHOLDER };
const NEEDS_PERIOD = "캠페인 일정을 먼저 정해야 상태를 바꿀 수 있습니다";

describe("PATCH — 기간 미정 캠페인은 준비에서 못 나간다(T-313)", () => {
  it("기간 미정 상태로 진행으로 바꾸면 409 + 사유, 아무것도 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous(UNSET));

    const response = await patch({ status: "ACTIVE" });
    expect(response.status).toBe(409);
    // `code` lets the client helper (campaign-patch.ts) show this reason instead of the group-conflict retry text.
    expect(await response.json()).toEqual({ error: NEEDS_PERIOD, code: "CAMPAIGN_PERIOD_REQUIRED" });
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("같은 요청에 판매 기간을 함께 정하면 통과하고 날짜가 저장된다", async () => {
    findUniqueMock.mockResolvedValue(previous(UNSET));

    const response = await patch({ status: "ACTIVE", startDate: "2026-11-20", endDate: "2026-11-27" });
    expect(response.status).toBe(200);
    const data = txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("ACTIVE");
    expect(data.startDate).toEqual(new Date("2026-11-20"));
    expect(data.endDate).toEqual(new Date("2026-11-27"));
  });

  it("같은 요청에 날짜를 한쪽만 보내면 아직 미정이라 409", async () => {
    findUniqueMock.mockResolvedValue(previous(UNSET));

    const response = await patch({ status: "ACTIVE", endDate: "2026-11-27" });
    expect(response.status).toBe(409);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("드랍은 기간 미정이어도 막지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous(UNSET));

    const response = await patch({ status: "DROPPED", dropReason: "조건 불일치" });
    expect(response.status).toBe(200);
    expect((txUpdateMock.mock.calls[0][0].data as Record<string, unknown>).status).toBe("DROPPED");
  });

  it("날짜만 저장하는 요청은 상태와 무관하게 통과한다 — 그 뒤엔 기간이 정해진 캠페인이다", async () => {
    findUniqueMock.mockResolvedValue(previous(UNSET));

    const response = await patch({ startDate: "2026-11-20", endDate: "2026-11-27" });
    expect(response.status).toBe(200);
    const data = txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    // The saved row no longer matches the placeholder, so the campaign reads as dated.
    expect(isCampaignPeriodUnset({
      startDate: data.startDate as Date,
      endDate: data.endDate as Date,
      periodPlaceholderAt: PLACEHOLDER,
    })).toBe(false);
  });

  it("정산 플래그가 다 차도 기간 미정 준비 캠페인은 상태를 옮기지 않고 플래그만 저장한다", async () => {
    findUniqueMock.mockResolvedValue(previous({ ...UNSET, isDepositReceived: true }));

    const response = await patch({ isPayoutCompleted: true });
    expect(response.status).toBe(200);
    const data = txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.isPayoutCompleted).toBe(true);
    expect(data.status).toBeUndefined();
  });

  it.each(["DROPPED", "PROPOSAL"])("이전 상태가 %s 여도 기간 미정이면 판매중으로 못 간다", async (from) => {
    findUniqueMock.mockResolvedValue(previous({ ...UNSET, status: from }));

    const response = await patch({ status: "ACTIVE" });
    expect(response.status).toBe(409);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("기간 미정이어도 드랍된 캠페인을 준비로 되돌리는 것은 막지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous({ ...UNSET, status: "DROPPED" }));

    const response = await patch({ status: "PREPARATION" });
    expect(response.status).toBe(200);
  });

  it("기간이 정해진 준비 캠페인은 종전처럼 진행으로 바꿀 수 있다", async () => {
    findUniqueMock.mockResolvedValue(previous({ ...UNSET, startDate: new Date("2026-11-20T00:00:00.000Z"), endDate: new Date("2026-11-30T00:00:00.000Z") }));

    const response = await patch({ status: "ACTIVE" });
    expect(response.status).toBe(200);
  });
});
