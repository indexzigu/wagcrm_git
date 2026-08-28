import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countDistinctSellerIds, isCrossSellerSet } from "@/lib/cross-seller";

/**
 * 셀러 단일성 **쓰기 차단** 계약 — 한 주문캠페인에 서로 다른 셀러의 판매캠페인이 붙는 상태를
 * 자동매핑이 애초에 만들지 못하게 한다(오너 결정 2026-08-05, 정책 = **전체 거부**).
 *
 * ## 무엇을 막는가
 *
 * 포털은 `salesCampaigns` 중 하나라도 자기 셀러면 그 캠페인을 "내 것"으로 보고 **캠페인 전체
 * 집계**를 렌더한다. 그래서 두 셀러가 한 주문캠페인에 붙으면 셀러 A 화면에 A+B 합산 매출이
 * A 의 실적으로 나간다(P0 「Seller-Facing Data Exposure」). 근거 정본은 `seller-portal.ts` 상단.
 *
 * ## 왜 "전체 거부"인가 (지배적 셀러 채택·부분 미매핑이 아니라)
 *
 * 옵션별 승자가 셀러별로 갈렸다는 것은 이 주문캠페인의 이름·옵션명이 여러 셀러의 딜과 비슷하게
 * 읽힌다는 뜻이다. 그 상태에서 절반을 확정하면 **어느 쪽이 맞는지 기계가 모르는 채로** 링크가
 * 남고, 잘못 붙은 링크는 곧바로 셀러 화면에 남의 매출을 실어 보낸다. 조용한 부분 성공보다
 * 시끄러운 전량 실패가 낫다.
 *
 * ## 이 파일이 고정하는 것
 *
 * - **C1** 쓰기 0건 — 거부 시 `productMapping.update` 도 `salesCampaign.updateMany` 도 부르지 않는다.
 *   🪤 이게 핵심이다: 종전 구현은 루프 **안에서** 곧바로 update 를 날렸으므로, 거부 판정만
 *   추가하면 이미 절반이 쓰인 상태가 됐다. 결정과 쓰기를 분리했는지를 여기서 잡는다.
 * - **C2** 양성 대조군 — 단일 셀러면 종전대로 쓴다(게이트가 전부를 막는 게 아님을 증명).
 * - **C3** 미입력 sellerId 를 "또 하나의 셀러"로 세지 않는다(정상 건 오탐 금지).
 */

const prismaMock = {
  orderCampaign: { findUnique: vi.fn() },
  salesCampaign: { findMany: vi.fn(), updateMany: vi.fn() },
  productMapping: { update: vi.fn() },
};

async function loadMappingService() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  vi.doMock("fs", () => ({ default: { appendFileSync: vi.fn() }, appendFileSync: vi.fn() }));
  return await import("../mapping-service");
}

// 가공 이름(P0: 커밋에 셀러 실명 금지) — 결함은 이름이 아니라 구조에서 재현된다.
const ALIAS_A = "알파";
const ALIAS_B = "베타";
// 스토어명이 두 셀러를 모두 포함해야 computeSellerScore 가 양쪽에 >0 을 준다 = 충돌 상황.
const STORE_NAME = `[${ALIAS_A} X ${ALIAS_B}] 공동 기획 마켓`;

const PRICE_A = 31900;
const PRICE_B = 42900;

function makeCampaignDeal(id: string, dealName: string, sellingPrice: number) {
  return { id, sellingPrice, deal: { id: `deal-${id}`, dealName, parentId: `p-${id}`, sellingPrice } };
}

function makeSalesCamp(
  id: string,
  sellerId: string | null | undefined,
  alias: string,
  campaignDeal: ReturnType<typeof makeCampaignDeal>,
) {
  return {
    id,
    sellerId,
    campaignName: `${alias} 캠페인`,
    seller: { alias, name: alias },
    deal: null,
    campaignDeals: [campaignDeal],
  };
}

/** 옵션 2개(각각 다른 딜에 맞물림) + 후보 캠페인들로 autoMap 을 돌린다. */
async function runAutoMap(candidates: ReturnType<typeof makeSalesCamp>[]) {
  vi.clearAllMocks();
  prismaMock.orderCampaign.findUnique.mockResolvedValue({
    id: "oc-1",
    name: STORE_NAME,
    sellerName: `${ALIAS_A} ${ALIAS_B}`,
    mappings: [
      { id: "m-a", optionName: "감마 단품", productName: "감마 단품", price: PRICE_A, campaignDealId: null },
      { id: "m-b", optionName: "델타 단품", productName: "델타 단품", price: PRICE_B, campaignDealId: null },
    ],
  });
  prismaMock.salesCampaign.findMany.mockResolvedValue(candidates);
  prismaMock.salesCampaign.updateMany.mockResolvedValue({ count: 0 });

  const { autoMapOrderCampaign } = await loadMappingService();
  const result = await autoMapOrderCampaign("oc-1");
  return {
    result,
    mappingUpdates: prismaMock.productMapping.update.mock.calls.length,
    salesCampUpdates: prismaMock.salesCampaign.updateMany.mock.calls.length,
  };
}

const dealGamma = () => makeCampaignDeal("cd-gamma", "감마 단품", PRICE_A);
const dealDelta = () => makeCampaignDeal("cd-delta", "델타 단품", PRICE_B);

afterEach(() => {
  vi.doUnmock("@/lib/order-converter/prisma");
  vi.doUnmock("fs");
});

describe("C0 — 판정 원시함수(@/lib/cross-seller)", () => {
  it("서로 다른 셀러 2곳이면 충돌이다", () => {
    expect(countDistinctSellerIds(["s1", "s2"])).toBe(2);
    expect(isCrossSellerSet(["s1", "s2"])).toBe(true);
  });

  it("같은 셀러가 여러 번이면 충돌이 아니다(정상 1:N)", () => {
    expect(countDistinctSellerIds(["s1", "s1", "s1"])).toBe(1);
    expect(isCrossSellerSet(["s1", "s1", "s1"])).toBe(false);
  });

  it("미입력(null·undefined·빈 문자열)은 세지 않는다 — 오탐 방지", () => {
    expect(countDistinctSellerIds([null, undefined, ""])).toBe(0);
    expect(isCrossSellerSet(["s1", null, undefined, ""])).toBe(false);
  });

  it("빈 집합은 충돌이 아니다", () => {
    expect(isCrossSellerSet([])).toBe(false);
  });
});

describe("C2 — 양성 대조군: 단일 셀러는 종전대로 매핑된다", () => {
  beforeEach(() => vi.clearAllMocks());

  it("두 옵션의 승자가 같은 셀러면 쓰기가 일어난다", async () => {
    const { mappingUpdates, salesCampUpdates } = await runAutoMap([
      makeSalesCamp("sc-1", "seller-1", ALIAS_A, dealGamma()),
      makeSalesCamp("sc-2", "seller-1", ALIAS_A, dealDelta()),
    ]);
    expect(mappingUpdates).toBeGreaterThan(0);
    expect(salesCampUpdates).toBeGreaterThan(0);
  });
});

describe("C1 — 충돌 시 전체 거부: 쓰기가 단 한 건도 없어야 한다", () => {
  beforeEach(() => vi.clearAllMocks());

  it("옵션별 승자가 서로 다른 셀러면 productMapping 도 salesCampaign 도 쓰지 않는다", async () => {
    // 🪤 **공허 통과 방지**: 승자를 아예 못 찾아도 쓰기는 0건이 된다. 그래서 "쓰기 0건"만
    // 단언하면 스코어링이 망가진 날에도 이 테스트는 초록불이다. 거부 경로에서만 나오는
    // console.warn 을 함께 단언해 **게이트가 실제로 발화했음**을 고정한다.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { result, mappingUpdates, salesCampUpdates } = await runAutoMap([
        makeSalesCamp("sc-1", "seller-1", ALIAS_A, dealGamma()),
        makeSalesCamp("sc-2", "seller-2", ALIAS_B, dealDelta()),
      ]);

      const rejected = warn.mock.calls.some((c) => String(c[0]).includes("[auto-map]"));
      expect(rejected, "셀러 단일성 게이트가 발화하지 않았다 — 이 테스트는 공허 통과다").toBe(true);

      // 부분 반영이 남으면 여기서 깨진다 — "결정 후 쓰기" 구조의 회귀 가드다.
      expect(mappingUpdates, "거부됐는데 ProductMapping 이 쓰였다(부분 반영)").toBe(0);
      expect(salesCampUpdates, "거부됐는데 SalesCampaign 링크가 갱신됐다").toBe(0);
      expect(result).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("C4 — 수동 저장 경로도 같은 게이트를 지난다(소스 계약)", () => {
  // 이 라우트는 PUT 하나에 naver 클라이언트·트랜잭션·스냅샷 동기화가 얽혀 있어 실행 테스트의
  // mock 비용이 크다. 그래서 `campaigns-handler.contract.test.ts` 선례대로 **소스 계약**으로
  // 고정한다 — 잡으려는 회귀는 "누군가 이 블록을 리팩터하며 검사를 떨어뜨리는 것"이다.
  const ROUTE = readFileSync(
    join(process.cwd(), "src", "app", "order-converter", "api", "campaigns", "[id]", "route.ts"),
    "utf8",
  );

  it("앵커가 살아 있다(음성 대조군 — 경로가 틀리면 아래가 공허 통과한다)", () => {
    expect(ROUTE.length).toBeGreaterThan(1000);
    expect(ROUTE).toContain("newSalesCampaignIds");
  });

  it("연결 대상 딜에서 판매캠페인의 sellerId 를 함께 조회한다", () => {
    // sellerId 를 안 가져오면 게이트가 판정할 재료 자체가 없다(#137 과 같은 부류의 침묵형 결함).
    expect(ROUTE).toMatch(/campaign:\s*\{\s*select:\s*\{\s*sellerId:\s*true/);
  });

  it("SSOT 판정을 호출하고 거부를 던진다", () => {
    expect(ROUTE).toContain("@/lib/cross-seller");
    expect(ROUTE).toMatch(/isCrossSellerSet\s*\(/);
    expect(ROUTE).toMatch(/throw new CrossSellerRejectedError\(\)/);
  });

  it("거부를 500 이 아니라 400 으로 돌려준다", () => {
    // 500 으로 내면 운영자에게 "시스템 고장"으로 읽혀 무엇을 고쳐야 하는지 전달되지 않는다.
    expect(ROUTE).toMatch(/CROSS_SELLER_REJECTED_CODE[\s\S]{0,200}status:\s*400/);
  });
});

describe("C3 — sellerId 미입력은 충돌로 보지 않는다", () => {
  beforeEach(() => vi.clearAllMocks());

  it("한쪽 sellerId 가 없어도 정상 매핑을 막지 않는다", async () => {
    const { mappingUpdates } = await runAutoMap([
      makeSalesCamp("sc-1", "seller-1", ALIAS_A, dealGamma()),
      makeSalesCamp("sc-2", null, ALIAS_A, dealDelta()),
    ]);
    expect(mappingUpdates).toBeGreaterThan(0);
  });
});
