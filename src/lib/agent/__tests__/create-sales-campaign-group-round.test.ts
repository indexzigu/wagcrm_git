import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CreateSalesCampaignGroupRoundArgs } from "@/lib/agent-worker/contracts";

const createInTxMock = vi.fn();
const createGroupMock = vi.fn();
vi.mock("@/services/campaignService", () => ({ createCampaignInTx: (...a: unknown[]) => createInTxMock(...a) }));
vi.mock("@/services/campaignGroupService", () => ({
  campaignGroupService: { createGroup: (...a: unknown[]) => createGroupMock(...a) },
}));

const { createSalesCampaignGroupRoundAction } = await import("../write-actions/create-sales-campaign-group-round");
const { AGENT_WORKER_ACTOR } = await import("@/lib/agent/agent-worker-proposal");
const { AGENT_MAPPING_APPLY_ACTOR } = await import("@/lib/agent-internal/actors");
const { describeSalesCampaignGroupRoundProposal } = await import("../tools/create-sales-campaign-group-round");
const { WRITE_ACTIONS, resolveWriteActionTxTimeoutMs } = await import("../write-executor");

const memberArgs = (dealId: string, dealName: string) => ({
  previousCampaignId: `prev-${dealId}`,
  previousCampaignName: `${dealName} - 샘플셀러`,
  dealId,
  dealName,
  salesChannel: "OWN_MALL_NAVER" as const,
  isManualMargin: false,
  totalMarginRate: 0,
  sellerMarginRate: 0,
  campaignItems: [{ dealId, dealName, feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 }],
  expectedRoundNumber: 2,
  expectedCampaignName: `${dealName} - 샘플셀러 2차`,
});

const args: CreateSalesCampaignGroupRoundArgs = {
  previousGroupId: "group-1",
  previousGroupName: "[샘플셀러] 딜A 외 1건",
  sellerId: "seller-1",
  sellerName: "샘플셀러",
  members: [memberArgs("deal-a", "딜A"), memberArgs("deal-b", "딜B")],
  product: {
    productId: "101",
    channelProductNo: "201",
    name: "[샘플셀러 X 샘플브랜드] 조합 2차",
    productStatus: "SALE",
    salePeriod: "2026.12.01 ~ 2026.12.07",
    source: "INPUT",
  },
  baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
  startDate: "2026-12-01",
  endDate: "2026-12-07",
  dateSource: "STORE",
  status: "PREPARATION",
  linkOrderCampaign: { id: "oc-2", name: "조합 2차 주문" },
  otherLinkedCampaigns: [],
};

function fakeTx(rounds: Array<{ dealId: string; campaignName: string | null; startDate: Date; endDate: Date }> = []) {
  const findMany = vi.fn(async () => rounds);
  return { tx: { salesCampaign: { findMany } } as unknown as Prisma.TransactionClient, findMany };
}

beforeEach(() => {
  createInTxMock.mockReset();
  createGroupMock.mockReset();
  let n = 0;
  createInTxMock.mockImplementation(async () => ({ id: `camp-new-${++n}`, campaignName: null }));
  createGroupMock.mockResolvedValue({ id: "group-new", name: "[샘플셀러] 딜A 외 1건" });
});

describe("create_sales_campaign_group_round 승인 실행", () => {
  it("캠페인마다 화면 생성과 같은 본체로 만들고, 같은 tx 안에서 새 그룹으로 묶는다", async () => {
    const { tx } = fakeTx();
    const result = await createSalesCampaignGroupRoundAction.handler(args, "owner-user-id", tx);
    expect(result).toMatchObject({
      refType: "CAMPAIGN_GROUP",
      refId: "group-new",
      createdCampaignIds: ["camp-new-1", "camp-new-2"],
      linkOrderCampaignId: "oc-2",
    });
    expect(result.summary).toContain("캠페인 2개");
    expect(createInTxMock).toHaveBeenCalledTimes(2);
    const [passedTx, input, auth] = createInTxMock.mock.calls[1] as [unknown, Record<string, unknown>, unknown];
    expect(passedTx).toBe(tx);
    expect(auth).toEqual({ userId: "owner-user-id" });
    expect(input).toMatchObject({
      dealId: "deal-b",
      sellerId: "seller-1",
      startDate: "2026-12-01",
      endDate: "2026-12-07",
      baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
      status: "PREPARATION",
      isManualMargin: false,
    });
    expect(input.campaignDeals).toEqual([
      { dealId: "deal-b", quantity: 0, actualSales: 0, feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 },
    ]);
    expect(createGroupMock).toHaveBeenCalledWith(["camp-new-1", "camp-new-2"], tx);
  });

  it.each([["SYSTEM_AUTO"], [AGENT_WORKER_ACTOR], [AGENT_MAPPING_APPLY_ACTOR]])("실행자 %s 는 쓰기 전에 거부", async (actor) => {
    const { tx, findMany } = fakeTx();
    await expect(createSalesCampaignGroupRoundAction.handler(args, actor, tx)).rejects.toThrow("사람이 결재함에서 승인");
    expect(findMany).not.toHaveBeenCalled();
    expect(createInTxMock).not.toHaveBeenCalled();
  });

  it("기안 뒤 어느 캠페인이든 같은 기간 회차가 생겼으면 하나도 만들지 않는다(KST 날짜로 대조)", async () => {
    const { tx } = fakeTx([
      {
        dealId: "deal-b",
        campaignName: "딜B - 샘플셀러 2차",
        startDate: new Date("2026-11-30T15:00:00.000Z"),
        endDate: new Date("2026-12-06T15:00:00.000Z"),
      },
    ]);
    await expect(createSalesCampaignGroupRoundAction.handler(args, "owner-user-id", tx)).rejects.toThrow("이미 있습니다");
    expect(createInTxMock).not.toHaveBeenCalled();
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("그룹 묶기가 실패하면 예외가 그대로 올라간다(승인 tx 전체 롤백)", async () => {
    const { tx } = fakeTx();
    createGroupMock.mockRejectedValue(new Error("이미 다른 그룹에 속해 있습니다"));
    await expect(createSalesCampaignGroupRoundAction.handler(args, "owner-user-id", tx)).rejects.toThrow("다른 그룹");
  });

  it("커밋 뒤 캐시·캘린더 1회·캠페인마다 드라이브, 주문캠페인 자동 연결", () => {
    const spec = createSalesCampaignGroupRoundAction.effects({
      refType: "CAMPAIGN_GROUP",
      refId: "group-new",
      summary: "s",
      createdCampaignIds: ["c1", "c2", "c3"],
      linkOrderCampaignId: "oc-2",
    });
    expect(spec).toMatchObject({ calendarCampaignId: "c1", driveFolderCampaignIds: ["c1", "c2", "c3"], autoMapOrderCampaignId: "oc-2" });
    expect(spec.revalidate.length).toBeGreaterThan(0);
  });

  it("승인 tx 시간 상한을 늘린다 — 다른 액션은 기본값 그대로", () => {
    expect(resolveWriteActionTxTimeoutMs("create_sales_campaign_group_round")).toBeGreaterThan(5000);
    expect(resolveWriteActionTxTimeoutMs("create_sales_campaign_round")).toBeUndefined();
    expect(resolveWriteActionTxTimeoutMs("constructor")).toBeUndefined();
    expect(Object.hasOwn(WRITE_ACTIONS, "create_sales_campaign_group_round")).toBe(true);
  });

  it("결재함 제목은 셀러·캠페인 수·기간·스토어 상품을 한 줄로", () => {
    expect(describeSalesCampaignGroupRoundProposal(args)).toBe(
      "판매캠페인 그룹 회차 등록: 샘플셀러 · 캠페인 2개 · 2026-12-01 ~ 2026-12-07 · 스토어 상품 「[샘플셀러 X 샘플브랜드] 조합 2차」",
    );
  });
});
