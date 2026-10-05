import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";

// 실매출 입력 라우트가 운영자의 수동값(수동 영업수익·판매대행비·제세공과금·정산 기준액)과
// 세무 유형을 계산에 넘기는지 고정한다. 종전엔 하나도 넘기지 않아 실매출을 고칠 때마다 수동값이
// 자동값으로 덮였다. 금액은 전부 가공이다(P0).

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      findUniqueOrThrow: (...args: unknown[]) => findUniqueOrThrowMock(...args),
    },
  }),
}));
vi.mock("@/lib/campaign-activity", () => ({ recordCampaignActivity: vi.fn() }));
vi.mock("@/lib/campaign-row", () => ({ toCampaignRow: (row: { id: string }) => ({ id: row.id }) }));
vi.mock("@/lib/cache-tags", () => ({ revalidateCampaignCaches: vi.fn() }));

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    isManualMargin: true,
    salesChannel: "BRAND_MALL",
    deal: { baseMarginPolicy: null },
    operatingExpense: 0,
    miscExpense: 0,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    sellerTaxType: "BUSINESS",
    seller: { agency: { businessNumber: "000-00-00000" } },
    campaignDeals: [],
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    settlementSales: null,
    sellerExpense: null,
    taxExpense: null,
    sellerFeeBasisOverride: null,
    ...overrides,
  };
}

async function patchActualSales(actualSales: number) {
  const response = await PATCH(
    new Request("http://localhost/api/campaigns/c1/actual-sales", {
      method: "PATCH",
      body: JSON.stringify({ actualSales }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
  expect(response.status).toBe(200);
  return updateMock.mock.calls[0][0].data as Record<string, number>;
}

beforeEach(() => {
  [findUniqueMock, updateMock, findUniqueOrThrowMock].forEach((mock) => mock.mockReset());
  updateMock.mockResolvedValue({ id: "c1" });
  findUniqueOrThrowMock.mockResolvedValue({ id: "c1" });
});

describe("PATCH /api/campaigns/[id]/actual-sales — 수동값을 덮지 않는다", () => {
  it("수동 영업수익·판매대행비·제세공과금이 그대로 남는다", async () => {
    findUniqueMock.mockResolvedValue(
      campaign({
        isManualSettlementSales: true,
        isManualSellerExpense: true,
        isManualTaxExpense: true,
        settlementSales: 250_000,
        sellerExpense: 0,
        taxExpense: 12_345,
      }),
    );
    const data = await patchActualSales(1_000_000);
    expect(data.settlementSales).toBe(250_000);
    expect(data.sellerExpense).toBe(0);
    expect(data.taxExpense).toBe(12_345);
  });

  it("수동 정산 기준액이 있으면 판매대행비 = round(기준액 × 요율)", async () => {
    findUniqueMock.mockResolvedValue(campaign({ sellerFeeBasisOverride: 900_000 }));
    const data = await patchActualSales(1_000_000);
    expect(data.sellerExpense).toBe(90_000);
  });

  it("사업자 셀러는 사업자로 계산한다(세무 유형 전달 — 종전엔 개인으로 계산)", async () => {
    findUniqueMock.mockResolvedValue(campaign());
    const data = await patchActualSales(1_100_000);
    // 사업자 기준 = 총 거래액 × 10% (개인이면 1,000,000 × 10% = 100,000)
    expect(data.sellerExpense).toBe(110_000);
  });
});
