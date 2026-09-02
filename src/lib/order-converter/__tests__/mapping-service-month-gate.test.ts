import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실사고 회귀(2026-07-18, prod): autoMapOrderCampaign(매핑 → 딜 자동 연결)에서 "3종 혼합 SET
// (3개월분)" 옵션이 1개월분 딜에 오배정됐다. computeSimilarityScore의 정규화가 '개월분'을 잡음
// 단어로 지우고 'N종/N박스'를 숫자만 남겨, 3개월분 옵션이 1개월분·3개월분 딜 양쪽과 유사도
// 동점(1.5=1.5)이 됐고, 선착순 tie-break가 먼저 순회된 1개월분 딜을 골랐다(가격 동점깨기도
// 매핑가≠딜정가라 무력). extractSupplyMonths 기반 기간 완전일치 게이트가 이를 가른다.
//
// 이름은 전부 가공(P0: 커밋에 셀러 실명 금지) — 버그는 이름이 아니라 구조(3종 혼합 SET,
// 1개월분 vs 3개월분 동점)에서 재현된다.

const prismaMock = {
  orderCampaign: {
    findUnique: vi.fn(),
  },
  salesCampaign: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  productMapping: {
    update: vi.fn(),
  },
};

async function loadMappingService() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  // 디버그 로그 파일 쓰기는 no-op 처리(워크트리에 mapping-debug.log 생성 방지).
  vi.doMock("fs", () => ({ default: { appendFileSync: vi.fn() }, appendFileSync: vi.fn() }));
  return await import("../mapping-service");
}

// 가공 이름 — [가상셀러 X 비타플러스] 3종 혼합 구조
const SELLER_ALIAS = "가상셀러";
const STORE_NAME = "[가상셀러 X 비타플러스]  에이 / 비 / 씨 3종 최저가 마켓";
const OPTION_3M = "제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)";
const OPTION_1M = "제품: [비타플러스] 3종 혼합 SET / 수량: [23%] 1+1+1박스 (1개월분)";
const OPTION_NO_MONTH = "제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스";
const DEAL_1M = "비타플러스 - 3종 혼합 (1개월분)";
const DEAL_3M = "비타플러스 - 3종 혼합 (3개월분)";
const DEAL_NO_MONTH_A = "비타플러스 - 3종 혼합 에이";
const DEAL_NO_MONTH_B = "비타플러스 - 3종 혼합 비";

// 하위 딜(parentDealId 존재)은 getDisplayDealName이 dealName을 그대로 반환한다.
function makeCampaignDeal(id: string, dealName: string, sellingPrice: number) {
  return {
    id,
    sellingPrice,
    deal: { id: `deal-${id}`, dealName, parentDealId: `parent-${id}`, sellingPrice },
  };
}

function makeSalesCamp(id: string, campaignName: string, campaignDeal: ReturnType<typeof makeCampaignDeal>) {
  return {
    id,
    campaignName,
    seller: { alias: SELLER_ALIAS, name: SELLER_ALIAS },
    deal: null,
    campaignDeals: [campaignDeal],
  };
}

// 옵션 1건 + 후보 캠페인 목록으로 autoMap을 돌리고, productMapping.update 에 실린 campaignDealId 반환.
async function runAutoMap(optionName: string, candidates: ReturnType<typeof makeSalesCamp>[]) {
  vi.clearAllMocks();
  prismaMock.orderCampaign.findUnique.mockResolvedValue({
    id: "oc-1",
    name: STORE_NAME,
    sellerName: SELLER_ALIAS,
    mappings: [
      {
        id: "m-1",
        optionName,
        productName: "에이+비+씨",
        // 매핑가 ≠ 딜 정가(228800) — 가격 동점깨기를 일부러 무력화해 기간 게이트만이 변별하도록.
        price: 212200,
        campaignDealId: null,
      },
    ],
  });
  prismaMock.salesCampaign.findMany.mockResolvedValue(candidates);
  prismaMock.salesCampaign.updateMany.mockResolvedValue({ count: 0 });

  const { autoMapOrderCampaign } = await loadMappingService();
  await autoMapOrderCampaign("oc-1");

  const call = prismaMock.productMapping.update.mock.calls[0];
  return call ? (call[0] as { data: { campaignDealId: string } }).data.campaignDealId : null;
}

describe("autoMapOrderCampaign — 기간(개월분) 완전일치 게이트 (실사고 회귀)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.doUnmock("@/lib/order-converter/prisma");
    vi.doUnmock("fs");
  });

  // 후보는 1개월분 딜을 먼저 둔다 — 게이트가 없으면 선착순으로 여기 오배정된다.
  const CANDIDATES_1M_FIRST = () => [
    makeSalesCamp("sc-1m", "1개월 캠페인", makeCampaignDeal("cd-1m", DEAL_1M, 228800)),
    makeSalesCamp("sc-3m", "3개월 캠페인", makeCampaignDeal("cd-3m", DEAL_3M, 228800)),
  ];

  it("3개월분 옵션은 3개월분 딜에 연결된다 (동점→선착순으로 1개월분에 오배정하지 않는다)", async () => {
    const linked = await runAutoMap(OPTION_3M, CANDIDATES_1M_FIRST());
    expect(linked).toBe("cd-3m");
  });

  it("1개월분 옵션은 1개월분 딜에 연결된다 (대조군)", async () => {
    const linked = await runAutoMap(OPTION_1M, CANDIDATES_1M_FIRST());
    expect(linked).toBe("cd-1m");
  });

  it("딜명에 개월분이 없으면 게이트를 적용하지 않고 기존 점수로 연결한다 (한쪽만 있으면 폴백)", async () => {
    const candidates = [
      makeSalesCamp("sc-a", "A 캠페인", makeCampaignDeal("cd-a", DEAL_NO_MONTH_A, 228800)),
      makeSalesCamp("sc-b", "B 캠페인", makeCampaignDeal("cd-b", DEAL_NO_MONTH_B, 228800)),
    ];
    // 옵션엔 3개월분이 있지만 딜엔 개월분이 없다 → 게이트 미적용 → 여전히 연결(미연결 아님).
    const linked = await runAutoMap(OPTION_3M, candidates);
    expect(linked).not.toBeNull();
  });

  it("옵션에 개월분이 없으면 게이트가 무력이고 기존 동작을 보존한다 (회귀 안전)", async () => {
    // 옵션에 월 공급량이 없다 → optionMonths=null → 게이트 미적용 → 기존 선착순(1개월분) 유지.
    const linked = await runAutoMap(OPTION_NO_MONTH, CANDIDATES_1M_FIRST());
    expect(linked).toBe("cd-1m");
  });
});
