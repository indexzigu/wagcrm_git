import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T-258 회귀 — 자동 연결이 **후보 창(최근 3개월 시작) 밖**의 기존 판매캠페인 연결을 떼지 않는다.
 *
 * 실사고 구조: 오래된 주문캠페인을 캠페인 설정에서 저장하면 PUT 이 운영자가 고른 딜대로 판매캠페인을
 * 붙인 직후, 백그라운드 autoMapOrderCampaign 이 다시 돈다. 종전 구현은 "이번 실행의 승자"만 남기고
 * 이 주문캠페인에 묶인 나머지 판매캠페인을 전부 풀었는데, 승자 후보가 최근 3개월 시작분뿐이라
 * 오래된 판매캠페인은 승자가 될 수 없어 저장할 때마다 연결이 0건이 됐다.
 *
 * 고정하는 것:
 * - K1 창 밖 기존 연결은 유지된다(해제 대상에서 빠지고, 연결 대상에 들어간다).
 * - K2 창 안 승자 + 창 밖 기존 연결(같은 셀러)은 함께 연결된다.
 * - K3 승자 셀러와 유지되는 기존 연결의 셀러가 다르면 전체 거부(쓰기 0건).
 * - K4 딜 연결이 하나도 없으면 종전대로 전부 해제한다(대조군).
 * - K5 유지분의 판매캠페인이 이미 다른 주문캠페인에 붙어 있으면 가져오지 않는다.
 * - K6 (T-260) 다른 주문캠페인에 붙은 새 회차 판매캠페인의 딜은 점수가 높아도 승자가 되지 않는다 —
 *   매핑의 딜 선택을 덮지 않고, 그 판매캠페인을 옮겨 오지도 않는다(옛 연결은 그대로 유지).
 * - K7 (대조군) 같은 새 회차 판매캠페인이 아무 주문캠페인에도 안 붙어 있으면 종전대로 승자가 된다.
 * - K8 (대조군) 후보 판매캠페인이 **이** 주문캠페인에 이미 붙어 있으면 제외되지 않고 승자가 된다.
 *
 * 이름은 전부 가공(P0: 커밋에 셀러 실명 금지).
 */

const prismaMock = {
  orderCampaign: { findUnique: vi.fn() },
  salesCampaign: { findMany: vi.fn(), updateMany: vi.fn() },
  campaignDeal: { findMany: vi.fn() },
  productMapping: { update: vi.fn() },
};

async function loadMappingService() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  vi.doMock("fs", () => ({ default: { appendFileSync: vi.fn() }, appendFileSync: vi.fn() }));
  return await import("../mapping-service");
}

const ALIAS = "알파";
const STORE_NAME = `[${ALIAS}] 감마 마켓`;
const PRICE = 31900;
// 창 밖 옵션은 가격까지 달라 창 안 딜과 어떤 점수도 겹치지 않게 한다(자동 연결은 점수가 기준을 넘으면
// 저장된 연결도 덮어쓰므로, 겹치면 "유지"가 아니라 "덮어쓰기"를 시험하게 된다).
const OLD_PRICE = 99000;

type Mapping = { id: string; optionName: string; productName: string; price: number; campaignDealId: string | null };

function makeCandidate(id: string, sellerId: string, dealId: string, dealName: string) {
  return {
    id,
    sellerId,
    orderCampaignId: null as string | null,
    campaignName: `${ALIAS} 캠페인`,
    seller: { alias: ALIAS, name: ALIAS },
    deal: null,
    campaignDeals: [
      { id: dealId, sellingPrice: PRICE, deal: { id: `deal-${dealId}`, dealName, parentDealId: `p-${dealId}`, sellingPrice: PRICE } },
    ],
  };
}

async function runAutoMap(opts: {
  mappings: Mapping[];
  candidates: ReturnType<typeof makeCandidate>[];
  outsideWindowDeals?: { id: string; campaignId: string; campaign: { sellerId: string; orderCampaignId: string | null } }[];
}) {
  vi.clearAllMocks();
  prismaMock.orderCampaign.findUnique.mockResolvedValue({
    id: "oc-1",
    name: STORE_NAME,
    sellerName: ALIAS,
    mappings: opts.mappings,
  });
  prismaMock.salesCampaign.findMany.mockResolvedValueOnce(opts.candidates).mockResolvedValue([]);
  prismaMock.salesCampaign.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.campaignDeal.findMany.mockResolvedValue(opts.outsideWindowDeals ?? []);

  const { autoMapOrderCampaign } = await loadMappingService();
  await autoMapOrderCampaign("oc-1");
  return prismaMock.salesCampaign.updateMany.mock.calls.map((call) => call[0]);
}

afterEach(() => {
  vi.doUnmock("@/lib/order-converter/prisma");
  vi.doUnmock("fs");
});

describe("autoMapOrderCampaign — 후보 창 밖 기존 연결 유지 (T-258)", () => {
  it("K1: 후보가 0건이어도 창 밖 판매캠페인 연결을 풀지 않는다", async () => {
    const calls = await runAutoMap({
      mappings: [{ id: "m-1", optionName: "옛 옵션", productName: "옛 상품", price: PRICE, campaignDealId: "cd-old" }],
      candidates: [],
      outsideWindowDeals: [{ id: "cd-old", campaignId: "sc-old", campaign: { sellerId: "seller-1", orderCampaignId: "oc-1" } }],
    });

    expect(calls).toEqual([
      { where: { orderCampaignId: "oc-1", id: { notIn: ["sc-old"] } }, data: { orderCampaignId: null } },
      { where: { id: { in: ["sc-old"] } }, data: { orderCampaignId: "oc-1" } },
    ]);
    expect(prismaMock.productMapping.update).not.toHaveBeenCalled();
  });

  it("K2: 창 안 승자와 창 밖 기존 연결(같은 셀러)을 함께 연결한다", async () => {
    const calls = await runAutoMap({
      mappings: [
        { id: "m-new", optionName: "감마 단품", productName: "감마 단품", price: PRICE, campaignDealId: null },
        { id: "m-old", optionName: "옛 옵션", productName: "옛 상품", price: OLD_PRICE, campaignDealId: "cd-old" },
      ],
      candidates: [makeCandidate("sc-new", "seller-1", "cd-new", "감마 단품")],
      outsideWindowDeals: [{ id: "cd-old", campaignId: "sc-old", campaign: { sellerId: "seller-1", orderCampaignId: "oc-1" } }],
    });

    expect(prismaMock.productMapping.update).toHaveBeenCalledWith({
      where: { id: "m-new" },
      data: { campaignDealId: "cd-new" },
    });
    expect(calls[0]).toEqual({
      where: { orderCampaignId: "oc-1", id: { notIn: ["sc-new", "sc-old"] } },
      data: { orderCampaignId: null },
    });
    expect(calls[1]).toEqual({ where: { id: { in: ["sc-new", "sc-old"] } }, data: { orderCampaignId: "oc-1" } });
  });

  it("K3: 승자 셀러와 유지되는 기존 연결의 셀러가 다르면 전체 거부한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = await runAutoMap({
      mappings: [
        { id: "m-new", optionName: "감마 단품", productName: "감마 단품", price: PRICE, campaignDealId: null },
        { id: "m-old", optionName: "옛 옵션", productName: "옛 상품", price: OLD_PRICE, campaignDealId: "cd-other" },
      ],
      candidates: [makeCandidate("sc-new", "seller-1", "cd-new", "감마 단품")],
      outsideWindowDeals: [{ id: "cd-other", campaignId: "sc-other", campaign: { sellerId: "seller-2", orderCampaignId: "oc-1" } }],
    });

    expect(calls).toEqual([]);
    expect(prismaMock.productMapping.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("K4(대조군): 딜 연결이 하나도 없으면 이 주문캠페인의 판매캠페인 연결을 전부 해제한다", async () => {
    const calls = await runAutoMap({
      mappings: [{ id: "m-1", optionName: "옛 옵션", productName: "옛 상품", price: PRICE, campaignDealId: null }],
      candidates: [],
    });

    expect(calls).toEqual([{ where: { orderCampaignId: "oc-1" }, data: { orderCampaignId: null } }]);
    expect(prismaMock.campaignDeal.findMany).not.toHaveBeenCalled();
  });

  it("K5: 유지분의 판매캠페인이 다른 주문캠페인에 붙어 있으면 가져오지 않는다", async () => {
    const calls = await runAutoMap({
      mappings: [{ id: "m-1", optionName: "옛 옵션", productName: "옛 상품", price: OLD_PRICE, campaignDealId: "cd-old" }],
      candidates: [],
      outsideWindowDeals: [{ id: "cd-old", campaignId: "sc-old", campaign: { sellerId: "seller-1", orderCampaignId: "oc-2" } }],
    });

    expect(calls).toEqual([{ where: { orderCampaignId: "oc-1" }, data: { orderCampaignId: null } }]);
  });

  // K6·K7 공통: 옛 회차 딜(창 밖)을 고른 매핑 1줄 + 같은 상품·같은 가격의 새 회차 딜(창 안).
  // 점수가 기준을 넘으므로, 소속 제외가 없으면 새 회차 딜이 승자가 되어 저장된 선택을 덮는다.
  const reRunMapping: Mapping = { id: "m-1", optionName: "감마 단품", productName: "감마 단품", price: PRICE, campaignDealId: "cd-old" };
  const oldRoundDeal = { id: "cd-old", campaignId: "sc-old", campaign: { sellerId: "seller-1", orderCampaignId: "oc-1" } };

  it("K6: 다른 주문캠페인에 붙은 새 회차 판매캠페인 딜은 승자가 되지 않는다 (T-260)", async () => {
    const newRound = { ...makeCandidate("sc-new", "seller-1", "cd-new", "감마 단품"), orderCampaignId: "oc-2" };
    const calls = await runAutoMap({ mappings: [reRunMapping], candidates: [newRound], outsideWindowDeals: [oldRoundDeal] });

    expect(prismaMock.productMapping.update).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { where: { orderCampaignId: "oc-1", id: { notIn: ["sc-old"] } }, data: { orderCampaignId: null } },
      { where: { id: { in: ["sc-old"] } }, data: { orderCampaignId: "oc-1" } },
    ]);
  });

  it("K7(대조군): 새 회차 판매캠페인이 어느 주문캠페인에도 안 붙어 있으면 종전대로 승자가 된다", async () => {
    const newRound = makeCandidate("sc-new", "seller-1", "cd-new", "감마 단품");
    const calls = await runAutoMap({ mappings: [reRunMapping], candidates: [newRound], outsideWindowDeals: [oldRoundDeal] });

    expect(prismaMock.productMapping.update).toHaveBeenCalledWith({ where: { id: "m-1" }, data: { campaignDealId: "cd-new" } });
    expect(calls[1]).toEqual({ where: { id: { in: ["sc-new"] } }, data: { orderCampaignId: "oc-1" } });
  });

  it("K8(대조군): 이 주문캠페인에 이미 붙은 후보 판매캠페인은 제외되지 않고 승자가 된다", async () => {
    const ownRound = { ...makeCandidate("sc-new", "seller-1", "cd-new", "감마 단품"), orderCampaignId: "oc-1" };
    const calls = await runAutoMap({ mappings: [reRunMapping], candidates: [ownRound], outsideWindowDeals: [oldRoundDeal] });

    expect(prismaMock.productMapping.update).toHaveBeenCalledWith({ where: { id: "m-1" }, data: { campaignDealId: "cd-new" } });
    expect(calls[1]).toEqual({ where: { id: { in: ["sc-new"] } }, data: { orderCampaignId: "oc-1" } });
  });
});
