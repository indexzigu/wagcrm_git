import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";
import { CAMPAIGN_FINANCIAL_STALE_CODE } from "@/lib/campaign-financial-guard";
import { revalidateCampaignCaches } from "@/lib/cache-tags";

// 재무 저장의 낙관적 동시성 가드. 화면이 본 이전 값(`expectedFinancials`)이 tx 안의
// 현재 DB 값과 다르면 409 + `code` 로 저장 전체를 버린다(`campaign-financial-guard.ts`).
// 실제 서비스 경로(campaignService.updateCampaign)를 탄다. 금액은 전부 가공이다(P0).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((callback: () => unknown) => callback()) };
});

const findUniqueMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const txUpdateMock = vi.fn();
const txFindUniqueMock = vi.fn();
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
        salesCampaign: {
          update: (...args: unknown[]) => txUpdateMock(...args),
          findUnique: (...args: unknown[]) => txFindUniqueMock(...args),
        },
        campaignDeal: {
          findMany: (...args: unknown[]) => txDealFindManyMock(...args),
          deleteMany: vi.fn(),
          update: vi.fn(),
          create: vi.fn(),
        },
      }),
  }),
}));
vi.mock("@/lib/campaign-activity", () => ({
  describeChangedFields: (fields: string[]) => fields.join(", "),
  recordCampaignActivity: (...args: unknown[]) => recordActivityMock(...args),
}));
vi.mock("@/lib/campaign-checklist", () => ({ ensureCampaignChecklistForStatus: vi.fn() }));
vi.mock("@/lib/campaign-row", async (importOriginal) => ({
  // 품목 대조는 화면 행과 같은 채움 함수를 써야 하므로 그것만은 진짜를 쓴다.
  resolveCampaignDealPrices: (await importOriginal<typeof import("@/lib/campaign-row")>()).resolveCampaignDealPrices,
  toCampaignRow: (row: { id: string }) => ({ id: row.id }),
  toKstDateStr: (value: Date | null) => value?.toISOString().slice(0, 10) ?? null,
}));
vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "user-1", email: "owner@example.com", role: "admin" }),
}));
vi.mock("@/lib/user-registry", () => ({ getCrmUsers: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/cache-tags", () => ({ revalidateCampaignCaches: vi.fn() }));
vi.mock("@/lib/google-calendar-sync", () => ({ syncCampaignToCalendar: vi.fn() }));

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

function writtenData() {
  expect(txUpdateMock).toHaveBeenCalledTimes(1);
  return txUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  [findUniqueMock, findUniqueOrThrowMock, txUpdateMock, txFindUniqueMock, txDealFindManyMock, recordActivityMock].forEach((m) =>
    m.mockReset(),
  );
  txUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c1", group: null, ...data }));
  findUniqueOrThrowMock.mockResolvedValue({ id: "c1" });
  vi.mocked(revalidateCampaignCaches).mockClear();
  findUniqueMock.mockResolvedValue(previous());
  txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);
});

/** DB 품목 행 — 스냅샷 수수료율이 비어 있어 화면은 딜 기본값(30)으로 보여 준다. */
function dbDeal(overrides: Record<string, unknown> = {}) {
  return {
    dealId: "d-1",
    quantity: 6,
    actualSales: "6000000",
    feeRate: null,
    sellerMarginRate: "10",
    costPrice: "700000",
    sellingPrice: "1000000",
    deal: { totalCommissionRate: "30", brokerageCommissionRate: null, costPrice: "700000", sellingPrice: "1000000" },
    ...overrides,
  };
}
/** 위 DB 행을 화면이 본 모양(채움 적용) */
const SEEN_DEAL = { dealId: "d-1", quantity: 6, actualSales: 6_000_000, feeRate: 30, sellerMarginRate: 10, costPrice: 700_000, sellingPrice: 1_000_000 };

/** tx 안에서 다시 읽는 「지금 DB 값」 — Prisma 는 Decimal 을 돌려주므로 문자열로 흉내 낸다. */
function currentInDb(overrides: Record<string, unknown> = {}) {
  return {
    operatingExpense: "0",
    miscExpense: "0",
    sellerFeeBasisOverride: null,
    settlementItems: [
      { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: "50000", note: "광고비" },
    ],
    campaignDeals: [dbDeal()],
    ...overrides,
  };
}

const SEEN_ITEMS = [{ invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 50_000, note: "광고비" }];

describe("PATCH expectedFinancials — 낡은 화면이 새 값을 덮어쓰지 못한다", () => {
  it("화면이 본 값이 DB 와 다르면 409 + code + 어긋난 필드, 아무것도 쓰지 않고 캐시도 안 깬다", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb({ operatingExpense: "120000" }));

    const response = await patch({ operatingExpense: 30_000, expectedFinancials: { fields: { operatingExpense: 0 } } });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: CAMPAIGN_FINANCIAL_STALE_CODE,
      fields: ["operatingExpense"],
    });
    expect(txUpdateMock).not.toHaveBeenCalled();
    expect(revalidateCampaignCaches).not.toHaveBeenCalled();
  });

  it("같으면(Decimal 문자열 vs 숫자) 저장하고, 기대값 자체는 쓰기 데이터에 섞이지 않는다", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb());

    const response = await patch({ operatingExpense: 30_000, expectedFinancials: { fields: { operatingExpense: 0 } } });

    expect(response.status).toBe(200);
    const data = writtenData();
    expect(data.operatingExpense).toBe(30_000);
    expect(data).not.toHaveProperty("expectedFinancials");
  });

  it("부가 항목 교체 — 그사이 DB 에 항목이 추가됐으면 옛 목록으로 지우지 않고 409", async () => {
    txFindUniqueMock.mockResolvedValue(
      currentInDb({
        settlementItems: [
          ...currentInDb().settlementItems,
          { invoiceMode: "NO_INVOICE", counterparty: "INTERNAL", amount: "-8000", note: "반품배송비" },
        ],
      }),
    );

    const response = await patch({
      settlementItems: [...SEEN_ITEMS, { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 1_000, note: null }],
      expectedFinancials: { settlementItems: SEEN_ITEMS },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).fields).toEqual(["settlementItems"]);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("부가 항목이 화면과 같으면 교체를 진행한다", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb());

    const response = await patch({
      settlementItems: [...SEEN_ITEMS, { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 1_000, note: null }],
      expectedFinancials: { settlementItems: SEEN_ITEMS },
    });

    expect(response.status).toBe(200);
    expect(writtenData().settlementItems).toBeDefined();
  });

  it("품목 교체 — 그사이 수량이 바뀌었으면 옛 품목 목록으로 덮지 않고 409", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb({ campaignDeals: [dbDeal({ quantity: 9 })] }));

    const response = await patch({
      campaignDeals: [{ dealId: "d-1", quantity: 7, actualSales: 7_000_000 }],
      expectedFinancials: { campaignDeals: [SEEN_DEAL] },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).fields).toEqual(["campaignDeals"]);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("품목 교체 — 그사이 판매가만 바뀌어도 409(저장이 그 값도 덮어쓰므로)", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb({ campaignDeals: [dbDeal({ sellingPrice: "1200000" })] }));

    const response = await patch({
      campaignDeals: [{ dealId: "d-1", quantity: 7, actualSales: 7_000_000 }],
      expectedFinancials: { campaignDeals: [SEEN_DEAL] },
    });

    expect(response.status).toBe(409);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("품목 교체 — 스냅샷이 비어 화면이 딜 기본값을 본 경우에도 같으면 통과한다(거짓 충돌 없음)", async () => {
    txFindUniqueMock.mockResolvedValue(currentInDb());

    const response = await patch({
      campaignDeals: [{ dealId: "d-1", quantity: 7, actualSales: 7_000_000 }],
      expectedFinancials: { campaignDeals: [SEEN_DEAL] },
    });

    expect(response.status).toBe(200);
  });

  it("기대값이 없으면(다른 화면의 저장) 대조 없이 종전대로 저장한다", async () => {
    const response = await patch({ operatingExpense: 30_000 });

    expect(response.status).toBe(200);
    expect(txFindUniqueMock).not.toHaveBeenCalled();
  });

  it("가드 목록 밖의 필드를 기대값에 넣으면 400(검증) — 오타가 조용히 대조를 건너뛰지 않게", async () => {
    const response = await patch({ operatingExpense: 30_000, expectedFinancials: { fields: { actualSales: 0 } } });

    expect(response.status).toBe(400);
    expect(txUpdateMock).not.toHaveBeenCalled();
  });
});


