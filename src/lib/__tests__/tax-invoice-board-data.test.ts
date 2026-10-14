/**
 * 세금계산서 보드의 공유 쿼리(`TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE`)는 보드가 쓰지 않는 관계를 뺐다
 * (CampaignDeal · SellersHistory · PartnerContact, 셀러 주민번호·계좌, 거래처 주소·계좌·이메일).
 * 그게 **보드 행을 바꾸지 않는다**는 것을 대조한다 — 종전(넓은 include) 모양과 좁힌 모양을 같은
 * `toCampaignRow` → `buildTaxInvoiceWorkBoard` 에 넣어 결과가 같아야 한다. 이름·번호는 전부 가짜다.
 */
import { describe, expect, it, vi } from "vitest";

const loadInvoiceProgress = vi.fn();
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: { loadInvoiceProgress: (...args: unknown[]) => loadInvoiceProgress(...args) },
}));

import { toCampaignRow } from "@/lib/campaign-row";
import { buildTaxInvoiceWorkBoard } from "@/lib/tax-filing-board";
import { loadTaxInvoiceWorkBoard, TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE } from "@/lib/tax-invoice-board-data";

function narrow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    dealId: "d1",
    sellerId: "s1",
    groupId: null,
    group: null,
    campaignName: "가짜딜 - 가짜셀러 1차",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    startDate: new Date("2026-09-01T00:00:00Z"),
    endDate: new Date("2026-09-10T00:00:00Z"),
    salesChannel: "SELLER_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 3_300_000,
    sellerExpense: 1_100_000,
    settlementSales: 990_000,
    totalMarginRate: 0,
    sellerMarginRate: 0,
    netMarginRate: 0,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    sellerTaxType: "BUSINESS",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    settlementItems: [
      { id: "i1", invoiceMode: "SALES_ISSUE", counterparty: "SELLER", amount: 110_000, note: null, sortOrder: 0 },
    ],
    deal: {
      dealName: "가짜딜",
      costPrice: 0,
      sellingPrice: 0,
      partner: { id: "p1", name: "가짜공급사", businessNumber: "1112223334", ceoName: "가짜대표", monthlySettlement: false },
    },
    seller: {
      name: "가짜셀러",
      alias: "가짜별칭",
      snsType: "INSTAGRAM",
      snsHandle: "fake",
      agency: { name: "가짜상사", type: "SELLER", businessNumber: "4445556667", ceoName: "가짜대표2" },
    },
    ...overrides,
  };
}

/** 종전 라우트의 넓은 include 가 돌려주던 모양 — 보드가 안 쓰는 관계·칸이 더 붙어 있다. */
function wide(base: ReturnType<typeof narrow>) {
  return {
    ...base,
    campaignDeals: [
      {
        id: "cd1",
        campaignId: base.id,
        dealId: "d1",
        quantity: 3,
        actualSales: 999,
        feeRate: 0.3,
        sellerMarginRate: 0.1,
        costPrice: 1,
        sellingPrice: 2,
        deal: { dealName: "다른 이름", totalCommissionRate: 0.5 },
      },
    ],
    deal: {
      ...base.deal,
      partner: { ...base.deal.partner, address: "가짜시 가짜로 1", representativeEmail: "placeholder-email-1", bankAccount: "000-000" },
    },
    seller: {
      ...base.seller,
      realName: "가짜실명",
      accountNumber: "111-222",
      residentNumber: null,
      histories: [{ snapshotDate: new Date("2026-01-01T00:00:00Z"), followersCount: 10 }],
      agency: {
        ...(base.seller.agency ?? {}),
        address: "가짜시 가짜로 2",
        bankAccount: "333-444",
        representativeEmail: null,
        contacts: [{ email: "placeholder-email-2" }],
      },
    },
  };
}

describe("tax invoice board shared query", () => {
  it("drops only relations the board does not read", () => {
    expect(Object.keys(TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE).sort()).toEqual(["deal", "group", "seller", "settlementItems"]);
    const json = JSON.stringify(TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE);
    for (const dropped of ["campaignDeals", "histories", "contacts", "residentNumber", "accountNumber", "realName", "address", "bankAccount", "representativeEmail"]) {
      expect(json, dropped).not.toContain(dropped);
    }
  });

  it.each([
    ["business seller, seller mall", {}],
    ["brand mall", { salesChannel: "BRAND_MALL" }],
    ["own mall, completed", { salesChannel: "OWN_MALL", status: "COMPLETED" }],
    ["seller without business entity (blocked)", { seller: { name: "가짜셀러", alias: null, snsType: "INSTAGRAM", snsHandle: "f", agency: null } }],
  ])("builds the same board from the narrow and the old wide shape: %s", (_label, overrides) => {
    const base = narrow(overrides);
    const fromNarrow = buildTaxInvoiceWorkBoard([toCampaignRow(base)], "2026-10");
    const fromWide = buildTaxInvoiceWorkBoard([toCampaignRow(wide(base) as unknown as typeof base)], "2026-10");
    expect(fromNarrow.rows.length).toBeGreaterThan(0);
    expect(fromNarrow).toEqual(fromWide);
  });

  it("loads settlement-stage campaigns with the shared include and asks progress only for monthly partners", async () => {
    const findMany = vi.fn().mockResolvedValue([
      narrow(),
      narrow({ id: "c2", deal: { dealName: "가짜딜2", costPrice: 0, sellingPrice: 0, partner: { id: "p2", name: "월정산공급사", businessNumber: "1", ceoName: "x", monthlySettlement: true } } }),
    ]);
    loadInvoiceProgress.mockResolvedValue(new Map());
    const prisma = { salesCampaign: { findMany } } as unknown as Parameters<typeof loadTaxInvoiceWorkBoard>[0];
    const { campaignRows, board } = await loadTaxInvoiceWorkBoard(prisma, "2026-10");
    expect(findMany).toHaveBeenCalledWith({
      where: { status: { in: ["SETTLEMENT_IN_PROGRESS", "COMPLETED"] } },
      include: TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE,
    });
    expect(loadInvoiceProgress).toHaveBeenCalledWith(prisma, ["c2"]);
    expect(campaignRows.map((row) => row.id)).toEqual(["c1", "c2"]);
    expect(board.month).toBe("2026-10");
  });
});
