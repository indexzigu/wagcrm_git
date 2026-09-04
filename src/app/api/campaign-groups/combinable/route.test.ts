import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const requireAuthMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

// getPrisma만 목업 — 실제 저장소 메서드와 실제 overlapsOrNear 판정이 그대로 돈다.
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany: (...args: unknown[]) => findManyMock(...args) },
  }),
}));

function campaignFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    status: "PROPOSAL",
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-07-05T00:00:00Z"),
    roundNumber: null,
    groupId: null,
    deal: { dealName: "비타민", brandName: "뉴트리원", partner: { name: "뷰티코리아" } },
    ...over,
  };
}

function req(qs: string) {
  return new NextRequest(`http://localhost:3000/api/campaign-groups/combinable?${qs}`);
}

const BASE_QS = "sellerId=s1&startDate=2026-07-01&endDate=2026-07-05";

beforeEach(() => {
  requireAuthMock.mockReset();
  findManyMock.mockReset();
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1" } });
});

describe("GET /api/campaign-groups/combinable", () => {
  it("같은 셀러의 미그룹 캠페인을 후보로 돌려준다", async () => {
    findManyMock.mockResolvedValue([campaignFixture()]);

    const response = await GET(req(`${BASE_QS}&excludeCampaignId=c9`));
    const body = await response.json();

    expect(response.status).toBe(200);
    // 근접 창(3일)만큼 넓힌 범위가 where 로 내려간다 — 순수 겹침 술어가
    // overlapsOrNear 와 등가라서 창 규칙을 SQL 에 다시 쓰지 않고도 인덱스를 탄다.
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      sellerId: "s1",
      startDate: { lte: new Date("2026-07-08") },
      endDate: { gte: new Date("2026-06-28") },
      id: { not: "c9" },
    });
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      campaignId: "c1",
      // 줄 제목은 딜 이름이다 — 캠페인명은 차수·셀러명을 이미 담아 배지와 겹친다(P2).
      dealName: "비타민",
      brandName: "뉴트리원",
      partnerName: "뷰티코리아",
      startDate: "2026-07-01",
      endDate: "2026-07-05",
    });
    expect(body.alreadyGroupedCount).toBe(0);
  });

  it("브랜드가 서로 달라도 후보에서 빼지 않는다", async () => {
    // 오너가 겪은 오진의 회귀 방지 — 그룹 조건은 셀러·기간이고 브랜드는 판정 축이 아니다.
    findManyMock.mockResolvedValue([
      campaignFixture({ id: "c1", deal: { dealName: "글로우", brandName: "뉴트리원", partner: { name: "뷰티코리아" } } }),
      campaignFixture({ id: "c2", deal: { dealName: "콜라겐", brandName: "센토메가", partner: { name: "뷰티코리아" } } }),
    ]);

    const response = await GET(req(BASE_QS));
    const body = await response.json();

    expect(body.candidates.map((c: { campaignId: string }) => c.campaignId)).toEqual(["c1", "c2"]);
  });

  it("이미 다른 그룹에 속한 캠페인은 후보에서 빼고 개수로만 알린다", async () => {
    findManyMock.mockResolvedValue([
      campaignFixture({ id: "c1", groupId: null }),
      campaignFixture({ id: "c2", groupId: "g1" }),
    ]);

    const response = await GET(req(BASE_QS));
    const body = await response.json();

    expect(body.candidates.map((c: { campaignId: string }) => c.campaignId)).toEqual(["c1"]);
    // 빈 상태 문구가 "없다"와 "이미 묶여 있다"를 갈라 말하려면 이 개수가 필요하다.
    expect(body.alreadyGroupedCount).toBe(1);
  });

  it("기간 창(겹침 또는 3일 이내) 밖은 후보에서 뺀다", async () => {
    findManyMock.mockResolvedValue([
      // 종료 다음날 시작 — 간격 1일이라 포함
      campaignFixture({
        id: "near",
        startDate: new Date("2026-07-06T00:00:00Z"),
        endDate: new Date("2026-07-09T00:00:00Z"),
      }),
      // 간격 10일 — 제외
      campaignFixture({
        id: "far",
        startDate: new Date("2026-07-15T00:00:00Z"),
        endDate: new Date("2026-07-18T00:00:00Z"),
      }),
    ]);

    const response = await GET(req(BASE_QS));
    const body = await response.json();

    expect(body.candidates.map((c: { campaignId: string }) => c.campaignId)).toEqual(["near"]);
    // 창 밖은 "이미 묶여 있다"가 아니므로 개수에도 잡히지 않는다.
    expect(body.alreadyGroupedCount).toBe(0);
  });

  it("필수 파라미터 누락은 400", async () => {
    const response = await GET(req("startDate=2026-07-01&endDate=2026-07-05"));
    expect(response.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
