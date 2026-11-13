import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CreateSalesCampaignRoundArgs } from "@/lib/agent-worker/contracts";

const createInTxMock = vi.fn();
vi.mock("@/services/campaignService", () => ({ createCampaignInTx: (...a: unknown[]) => createInTxMock(...a) }));

const { createSalesCampaignRoundAction } = await import("../write-actions/create-sales-campaign-round");
const { AGENT_WORKER_ACTOR } = await import("@/lib/agent/agent-worker-proposal");
const { AGENT_MAPPING_APPLY_ACTOR } = await import("@/lib/agent-internal/actors");
const { describeSalesCampaignRoundProposal } = await import("../tools/create-sales-campaign-round");

const args: CreateSalesCampaignRoundArgs = {
  previousCampaignId: "camp-1",
  previousCampaignName: "샘플딜 - 샘플셀러",
  dealId: "deal-1",
  dealName: "샘플딜",
  sellerId: "seller-1",
  sellerName: "샘플셀러",
  salesChannel: "OWN_MALL_NAVER",
  isManualMargin: true,
  totalMarginRate: 30,
  sellerMarginRate: 12,
  campaignItems: [
    { dealId: "deal-1", dealName: "샘플딜", feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 },
  ],
  product: {
    productId: "101",
    channelProductNo: "201",
    name: "[샘플셀러 X 샘플브랜드] 비타민 2차",
    productStatus: "SALE",
    salePeriod: "2026.12.01 ~ 2026.12.07",
    source: "INPUT",
  },
  baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
  startDate: "2026-12-01",
  endDate: "2026-12-07",
  dateSource: "STORE",
  status: "PREPARATION",
  expectedRoundNumber: 2,
  expectedCampaignName: "샘플딜 - 샘플셀러 2차",
  existingRounds: [],
  linkOrderCampaign: { id: "oc-2", name: "비타민 2차 주문" },
};

function fakeTx(rounds: Array<{ campaignName: string | null; startDate: Date; endDate: Date }> = []) {
  const findMany = vi.fn(async () => rounds);
  return { tx: { salesCampaign: { findMany } } as unknown as Prisma.TransactionClient, findMany };
}

beforeEach(() => {
  createInTxMock.mockReset();
  createInTxMock.mockResolvedValue({ id: "camp-new", campaignName: "샘플딜 - 샘플셀러 2차", roundNumber: 2, status: "PREPARATION" });
});

describe("create_sales_campaign_round 승인 실행", () => {
  it("사람이 승인하면 화면 생성과 같은 본체로 만들고, 하위품목은 수량·매출 0 으로 잇는다", async () => {
    const { tx } = fakeTx();
    const result = await createSalesCampaignRoundAction.handler(args, "owner-user-id", tx);
    expect(result).toMatchObject({ refType: "CAMPAIGN", refId: "camp-new", linkOrderCampaignId: "oc-2" });
    expect(result.summary).toContain("샘플딜 - 샘플셀러 2차");
    const [passedTx, input, auth] = createInTxMock.mock.calls[0] as [unknown, Record<string, unknown>, unknown];
    expect(passedTx).toBe(tx);
    expect(auth).toEqual({ userId: "owner-user-id" });
    expect(input).toMatchObject({
      dealId: "deal-1",
      sellerId: "seller-1",
      startDate: "2026-12-01",
      endDate: "2026-12-07",
      salesChannel: "OWN_MALL_NAVER",
      baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
      status: "PREPARATION",
      isManualMargin: true,
      totalMarginRate: 30,
      sellerMarginRate: 12,
    });
    expect(input.campaignName).toBeUndefined();
    expect(input.campaignDeals).toEqual([
      { dealId: "deal-1", quantity: 0, actualSales: 0, feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 },
    ]);
  });

  it.each([["SYSTEM_AUTO"], [AGENT_WORKER_ACTOR], [AGENT_MAPPING_APPLY_ACTOR]])("실행자 %s 는 쓰기 전에 거부", async (actor) => {
    const { tx, findMany } = fakeTx();
    await expect(createSalesCampaignRoundAction.handler(args, actor, tx)).rejects.toThrow("사람이 결재함에서 승인");
    expect(findMany).not.toHaveBeenCalled();
    expect(createInTxMock).not.toHaveBeenCalled();
  });

  it("기안 뒤 같은 기간 회차가 생겼으면 만들지 않는다(KST 날짜로 대조)", async () => {
    const { tx } = fakeTx([
      { campaignName: "샘플딜 - 샘플셀러 2차", startDate: new Date("2026-11-30T15:00:00.000Z"), endDate: new Date("2026-12-06T15:00:00.000Z") },
    ]);
    await expect(createSalesCampaignRoundAction.handler(args, "owner-user-id", tx)).rejects.toThrow("이미 있습니다");
    expect(createInTxMock).not.toHaveBeenCalled();
  });

  it("커밋 뒤 화면 생성과 같이 캐시·캘린더·드라이브를 돌리고, 기안 시점 주문캠페인이 있으면 자동 연결도", () => {
    const withLink = createSalesCampaignRoundAction.effects({ refType: "CAMPAIGN", refId: "camp-new", summary: "s", linkOrderCampaignId: "oc-2" });
    expect(withLink).toMatchObject({ calendarCampaignId: "camp-new", driveFolderCampaignId: "camp-new", autoMapOrderCampaignId: "oc-2" });
    expect(withLink.revalidate.length).toBeGreaterThan(0);
    const without = createSalesCampaignRoundAction.effects({ refType: "CAMPAIGN", refId: "camp-new", summary: "s" });
    expect(without.autoMapOrderCampaignId).toBeUndefined();
  });

  it("결재함 제목은 예상 이름·기간·스토어 상품을 한 줄로", () => {
    expect(describeSalesCampaignRoundProposal(args)).toBe(
      "판매캠페인 회차 등록: 샘플딜 - 샘플셀러 2차 · 2026-12-01 ~ 2026-12-07 · 스토어 상품 「[샘플셀러 X 샘플브랜드] 비타민 2차」",
    );
  });
});
