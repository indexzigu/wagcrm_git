import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";
import { SELLER_FEE_BASIS_MIXED_RATE_MESSAGE } from "@/lib/campaign-financials";

// 캠페인 PATCH 의 수동 정산 기준액(오너 확정 2026-10-06) — 요율 자격 거부(400) · 저장 판매대행비 ·
// 이력(이전값 → 새 값) · 이력 행위자(로그인 사용자, "SYSTEM" 아님)를 실제 서비스 경로로 고정한다.
// `campaign-financials` 는 진짜를 쓴다(기존 route.test.ts 는 그 모듈을 목으로 바꿔 이 경로를 못 본다).
// 금액·이메일은 전부 가공이다(P0).

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
const MIXED_RATE_DEALS: Deal[] = [
  { id: "cd-1", dealId: "d-1", actualSales: 6_000_000, sellerMarginRate: 10, feeRate: null },
  { id: "cd-2", dealId: "d-2", actualSales: 4_000_000, sellerMarginRate: 20, feeRate: null },
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
  [findUniqueMock, findUniqueOrThrowMock, txUpdateMock, txDealFindManyMock, recordActivityMock].forEach((m) =>
    m.mockReset(),
  );
  txUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c1", group: null, ...data }));
  findUniqueOrThrowMock.mockResolvedValue({ id: "c1" });
});

describe("PATCH sellerFeeBasisOverride — 수동 정산 기준액", () => {
  it("저장: 판매대행비 = round(기준액 × 단일 요율) — 품목 합계를 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous());
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    const response = await patch({ sellerFeeBasisOverride: 9_600_000 });
    expect(response.status).toBe(200);

    const data = writtenData();
    expect(data.sellerFeeBasisOverride).toBe(9_600_000);
    expect(data.sellerExpense).toBe(960_000);
  });

  it("수동 판매대행비가 켜져 있으면 기준액보다 그 값이 이긴다", async () => {
    findUniqueMock.mockResolvedValue(previous({ isManualSellerExpense: true, sellerExpense: 500_000 }));
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    await patch({ sellerFeeBasisOverride: 9_600_000 });
    expect(writtenData().sellerExpense).toBe(500_000);
  });

  it("품목마다 셀러 수수료율이 다르면 400 + 한국어 사유, 아무것도 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous({}, MIXED_RATE_DEALS));

    const response = await patch({ sellerFeeBasisOverride: 9_600_000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: SELLER_FEE_BASIS_MIXED_RATE_MESSAGE });
    expect(txUpdateMock).not.toHaveBeenCalled();
  });

  it("기준액이 있는 캠페인의 품목 요율을 섞이게 바꾸는 저장도 거부한다", async () => {
    findUniqueMock.mockResolvedValue(previous({ sellerFeeBasisOverride: 9_600_000 }));

    const response = await patch({
      campaignDeals: MIXED_RATE_DEALS.map(({ dealId, actualSales, sellerMarginRate }) => ({
        dealId,
        quantity: 1,
        actualSales,
        sellerMarginRate,
      })),
    });
    expect(response.status).toBe(400);
  });

  it("요율이 섞인 캠페인이라도 자동으로 되돌리는(null) 저장은 허용한다", async () => {
    findUniqueMock.mockResolvedValue(previous({ sellerFeeBasisOverride: 9_600_000 }, MIXED_RATE_DEALS));
    txDealFindManyMock.mockResolvedValue(MIXED_RATE_DEALS);

    const response = await patch({ sellerFeeBasisOverride: null });
    expect(response.status).toBe(200);
    // 자동 = 품목 합계(사업자: 6,000,000 × 10% + 4,000,000 × 20%)
    expect(writtenData().sellerExpense).toBe(1_400_000);
  });

  it("음수는 검증에서 거부한다(0 은 허용)", async () => {
    findUniqueMock.mockResolvedValue(previous());
    expect((await patch({ sellerFeeBasisOverride: -1 })).status).toBe(400);
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);
    expect((await patch({ sellerFeeBasisOverride: 0 })).status).toBe(200);
  });

  it("이력: 이전값 → 새 값을 남기고, 행위자는 로그인 사용자다(SYSTEM 아님)", async () => {
    findUniqueMock.mockResolvedValue(previous());
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    await patch({ sellerFeeBasisOverride: 9_600_000 });

    const calls = recordActivityMock.mock.calls.map(([input]) => input as Record<string, unknown>);
    const basisEntry = calls.find((c) => c.action === "SELLER_FEE_BASIS_UPDATED");
    expect(basisEntry).toMatchObject({
      label: "정산 기준액",
      details: "자동 → 수동 9,600,000원",
      actor: "owner@example.com",
    });
    // 한 번의 변경 = 이력 한 건 — 기준액만 바꾼 저장은 일반 UPDATED 이력을 남기지 않는다.
    expect(calls.filter((c) => c.action === "UPDATED")).toEqual([]);
    expect(calls).toHaveLength(1);
    for (const call of calls) expect(call.actor).not.toBe("SYSTEM");
  });

  it("다른 필드와 함께 바꾸면 일반 이력은 그 필드만 담고(기준액 제외), 행위자는 로그인 사용자다", async () => {
    findUniqueMock.mockResolvedValue(previous());
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    await patch({ sellerFeeBasisOverride: 9_600_000, operatingExpense: 5_000 });

    const calls = recordActivityMock.mock.calls.map(([input]) => input as Record<string, unknown>);
    const updated = calls.filter((c) => c.action === "UPDATED");
    expect(updated).toHaveLength(1);
    expect(updated[0].details).toBe("operating expense");
    expect(updated[0].actor).toBe("owner@example.com");
    expect(calls.filter((c) => c.action === "SELLER_FEE_BASIS_UPDATED")).toHaveLength(1);
  });

  it("이력: 수동 → 자동 전환도 이전값과 함께 남는다", async () => {
    findUniqueMock.mockResolvedValue(previous({ sellerFeeBasisOverride: 9_600_000 }));
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    await patch({ sellerFeeBasisOverride: null });

    const basisEntry = recordActivityMock.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find((c) => c.action === "SELLER_FEE_BASIS_UPDATED");
    expect(basisEntry?.details).toBe("수동 9,600,000원 → 자동");
  });

  it("같은 값 재전송은 이력을 남기지 않는다", async () => {
    findUniqueMock.mockResolvedValue(previous({ sellerFeeBasisOverride: 9_600_000 }));
    txDealFindManyMock.mockResolvedValue(SAME_RATE_DEALS);

    await patch({ sellerFeeBasisOverride: 9_600_000 });
    expect(
      recordActivityMock.mock.calls.some(([input]) => (input as { action: string }).action === "SELLER_FEE_BASIS_UPDATED"),
    ).toBe(false);
  });
});
