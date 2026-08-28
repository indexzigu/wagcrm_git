import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실사고 회귀(2026-07-19, prod): recommended-deals(매핑 드롭다운의 "추천 캠페인 점수순")가
// autoMapOrderCampaign의 스코어링 루프를 복붙해 쓰면서 PR #45의 기간(개월분) 완전일치 게이트가
// autoMap 인라인에만 적용됐다. 그 결과 오너가 매핑 화면에서 "3개월분 옵션"에 "1개월분 딜"이
// 여전히 50점으로 추천되는 걸 관찰했다("아직도 50점을 배정하는데").
//
// 스코어링을 scoreDealCandidate SSOT로 통일하면서 이 라우트도 게이트를 상속한다. 이 테스트는
// 라우트가 실제로 기간 불일치 딜을 추천에서 제외하는지 잠근다.
//
// 이름은 전부 가공(P0: 커밋에 셀러 실명 금지) — 버그는 이름이 아니라 구조에서 재현된다.

const prismaMock = {
  orderCampaign: {
    findUnique: vi.fn(),
  },
  salesCampaign: {
    findMany: vi.fn(),
  },
};

async function loadRoute() {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
  return await import("../route");
}

const SELLER_ALIAS = "가상셀러";
const STORE_NAME = "[가상셀러 X 비타플러스]  에이 / 비 / 씨 3종 최저가 마켓";
const OPTION_3M = "제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)";
const DEAL_1M = "비타플러스 - 3종 혼합 (1개월분)";
const DEAL_3M = "비타플러스 - 3종 혼합 (3개월분)";

function makeCampaignDeal(id: string, dealName: string, sellingPrice: number) {
  return {
    id,
    sellingPrice,
    deal: { id: `deal-${id}`, dealName, parentId: `parent-${id}`, sellingPrice },
  };
}

function makeSalesCamp(id: string, campaignName: string, campaignDeal: ReturnType<typeof makeCampaignDeal>) {
  return {
    id,
    campaignName,
    seller: { alias: SELLER_ALIAS, name: SELLER_ALIAS },
    campaignDeals: [campaignDeal],
  };
}

async function runRoute(optionName: string, candidates: ReturnType<typeof makeSalesCamp>[]) {
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
        price: 212200, // 딜 정가(228800)와 불일치 — 가격 동점깨기 무력화, 기간 게이트만 변별.
        campaignDealId: null,
      },
    ],
  });
  prismaMock.salesCampaign.findMany.mockResolvedValue(candidates);

  const { GET } = await loadRoute();
  const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "oc-1" }) });
  const body = await res.json();
  return body.recommendations["m-1"] as Array<{ id: string; name: string; score: number }>;
}

describe("recommended-deals — 기간(개월분) 완전일치 게이트 (실사고 회귀)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.doUnmock("@/lib/order-converter/prisma"));

  const CANDIDATES = () => [
    makeSalesCamp("sc-1m", "1개월 캠페인", makeCampaignDeal("cd-1m", DEAL_1M, 228800)),
    makeSalesCamp("sc-3m", "3개월 캠페인", makeCampaignDeal("cd-3m", DEAL_3M, 228800)),
  ];

  it("3개월분 옵션 추천에서 1개월분 딜은 제외되고 3개월분 딜만 남는다", async () => {
    const recs = await runRoute(OPTION_3M, CANDIDATES());
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("cd-3m");
    expect(ids).not.toContain("cd-1m"); // 오너가 본 "1개월분 딜 50점"이 이제 사라진다
  });

  it("딜에 개월분이 없으면 게이트 미적용 — 추천에 그대로 남는다(폴백=회귀 안전)", async () => {
    const candidates = [
      makeSalesCamp("sc-a", "A 캠페인", makeCampaignDeal("cd-a", "비타플러스 - 3종 혼합 에이", 228800)),
    ];
    const recs = await runRoute(OPTION_3M, candidates);
    expect(recs.map((r) => r.id)).toContain("cd-a");
  });

  // 모달 자동채움(기간 정확일치 유일 후보)·가격 확인 배지가 소비하는 계약 필드.
  it("추천 항목에 periodExact(기간 정확일치)와 dealPrice(딜 등록가)를 싣는다", async () => {
    const recs = await runRoute(OPTION_3M, CANDIDATES());
    const rec3m = recs.find((r) => r.id === "cd-3m") as any;
    expect(rec3m).toBeDefined();
    expect(rec3m.periodExact).toBe(true); // 옵션 3개월분 = 딜 3개월분
    expect(rec3m.dealPrice).toBe(228800); // 옵션가(212200)와 불일치 → 배지 근거
  });

  it("옵션에 개월분이 없으면 periodExact=false (자동채움 ② 규칙 비활성)", async () => {
    const recs = await runRoute("제품: [비타플러스] 3종 혼합 SET", [
      makeSalesCamp("sc-3m", "3개월 캠페인", makeCampaignDeal("cd-3m", DEAL_3M, 228800)),
    ]);
    const rec = recs.find((r) => r.id === "cd-3m") as any;
    expect(rec).toBeDefined();
    expect(rec.periodExact).toBe(false);
  });

  // code-reviewer MEDIUM 회귀: top-10 절단이 점수 낮은 기간일치 후보를 잘라내면, 모달
  // 자동채움 ②가 "10위 안에서만 유일"을 진짜 유일로 오판해 엉뚱한 회차에 자동 연결된다.
  // 기간일치 후보는 절단에서 보존돼야 유일성 판정이 전체 후보 기준이 된다.
  it("기간 정확일치 후보는 top-10 절단에서 보존된다(가짜 유일성 방지)", async () => {
    // 개월분 없는(=게이트 미적용) 고점수 후보 10개 + 이름이 덜 닮아 점수가 낮은 3개월분 후보 2개.
    const fillers = Array.from({ length: 10 }, (_, i) =>
      makeSalesCamp(`sc-f${i}`, `필러 ${i}`, makeCampaignDeal(`cd-f${i}`, `비타플러스 3종 혼합 SET 세트상품 ${i}`, 212200)),
    );
    // 이름 신호는 있지만(비타플러스 겹침) 필러보다 점수가 낮은 기간일치 회차 2건 —
    // 가격도 불일치라 priceScore(+50) 없이 유사도만으로 10위 밖으로 밀린다.
    const weak3m = [
      makeSalesCamp("sc-w1", "회차 1", makeCampaignDeal("cd-w1", "비타플러스 리뉴얼 (3개월분)", 1111)),
      makeSalesCamp("sc-w2", "회차 2", makeCampaignDeal("cd-w2", "비타플러스 프리미엄 (3개월분)", 2222)),
    ];
    const recs = await runRoute(OPTION_3M, [...fillers, ...weak3m]);
    const ids = recs.map((r) => r.id);
    // 저점수 기간일치 2건이 모두 살아남아야 모달이 "유일 아님"을 알 수 있다.
    expect(ids).toContain("cd-w1");
    expect(ids).toContain("cd-w2");
    expect(recs.length).toBeGreaterThan(10);
  });
});
