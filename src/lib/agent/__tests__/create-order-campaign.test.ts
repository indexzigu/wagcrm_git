import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createOrderCampaignAction } from "../write-actions/create-order-campaign";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import { AGENT_MAPPING_APPLY_ACTOR } from "@/lib/agent-internal/actors";
import type { CreateOrderCampaignArgs } from "@/lib/agent-worker/contracts";

const args: CreateOrderCampaignArgs = {
  productId: "103",
  channelProductNo: "203",
  name: "[샘플셀러 X 샘플브랜드] 유산균",
  sellerName: "샘플셀러",
  template: "sample-brand",
  templateName: "샘플거래처",
  toEmail: "to@example.com",
  ccEmail: null,
  thumbnailUrl: null,
  category: "유산균",
  productStatus: "SALE",
  salePeriod: "2026.11.20 ~ 2026.11.26",
  mappings: [
    { productName: "p", optionName: "구성: 2박스", price: 55000 },
    { productName: "p", optionName: "구성: 1박스", price: 30000 },
  ],
  sameProductCampaigns: [],
};

function fakeTx() {
  const create = vi.fn(async () => ({ id: "oc-new", name: args.name }));
  return { tx: { orderCampaign: { create } } as unknown as Prisma.TransactionClient, create };
}

describe("create_order_campaign 승인 실행", () => {
  it("사람이 승인하면 등록 라우트와 같은 칸으로 만들고, 상품코드는 비워 둔다", async () => {
    const { tx, create } = fakeTx();
    const result = await createOrderCampaignAction.handler(args, "owner-user-id", tx);
    expect(result).toMatchObject({ refType: "ORDER_CAMPAIGN", refId: "oc-new", createdCount: 2 });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      name: args.name,
      sellerName: "샘플셀러",
      template: "sample-brand",
      toEmail: "to@example.com",
      ccEmail: null,
      productId: "103",
      salePeriod: "2026.11.20 ~ 2026.11.26",
    });
    expect(data.mappings).toEqual({
      create: [
        { productName: "p", optionName: "구성: 1박스", brandCode: "", price: 30000 },
        { productName: "p", optionName: "구성: 2박스", brandCode: "", price: 55000 },
      ],
    });
  });

  it("기안이 이어받은 상품코드는 그 줄에만 싣는다", async () => {
    const { tx, create } = fakeTx();
    await createOrderCampaignAction.handler(
      {
        ...args,
        mappings: [args.mappings[0], { ...args.mappings[1], brandCode: "NT001" }],
        brandCodeSource: { kind: "SAME_PRODUCT", orderCampaignId: "oc-prev", orderCampaignName: "지난 회차", inheritedRows: 1 },
      },
      "owner-user-id",
      tx,
    );
    const data = (create.mock.calls[0] as unknown as [{ data: { mappings: { create: unknown[] } } }])[0].data;
    expect(data.mappings.create).toEqual([
      { productName: "p", optionName: "구성: 1박스", brandCode: "NT001", price: 30000 },
      { productName: "p", optionName: "구성: 2박스", brandCode: "", price: 55000 },
    ]);
  });

  it.each([["SYSTEM_AUTO"], [AGENT_WORKER_ACTOR], [AGENT_MAPPING_APPLY_ACTOR]])("실행자 %s 는 쓰기 전에 거부", async (actor) => {
    const { tx, create } = fakeTx();
    await expect(createOrderCampaignAction.handler(args, actor, tx)).rejects.toThrow("사람이 결재함에서 승인");
    expect(create).not.toHaveBeenCalled();
  });

  it("커밋 뒤 화면 등록과 같이 자동 연결·주문 동기화를 돌린다(캐시 태그 무효화 없음)", () => {
    expect(createOrderCampaignAction.effects({ refType: "ORDER_CAMPAIGN", refId: "oc-new", summary: "s" })).toEqual({
      revalidate: [],
      calendarCampaignId: null,
      autoMapOrderCampaignId: "oc-new",
    });
  });
});
