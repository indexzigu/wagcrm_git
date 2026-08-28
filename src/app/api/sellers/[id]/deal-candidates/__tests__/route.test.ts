// 라우트 계약 — 인증 필수 · 없는 셀러 404 · 후보 풀은 진행 가능한 본품 딜뿐 ·
// 집계 스코프가 이 셀러로 좁혀짐.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY_MS = 86_400_000;

const prismaMock = {
  seller: { findUnique: vi.fn() },
  deal: { findMany: vi.fn() },
  salesCampaign: { groupBy: vi.fn() },
  salesTask: { findMany: vi.fn() },
  actionProposal: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/api-auth", () => ({ requireAuth: vi.fn() }));

import { GET } from "../route";
import { requireAuth } from "@/lib/api-auth";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 후보 풀 조회(where 가 있는 쪽)만 골라낸다 — 거래처 매핑용 전체 조회와 구분. */
const poolCall = () =>
  prismaMock.deal.findMany.mock.calls.find((c) => c[0]?.where !== undefined)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ authenticated: true, context: {} } as never);
  prismaMock.seller.findUnique.mockResolvedValue({ id: "s1" });
  prismaMock.deal.findMany.mockResolvedValue([]);
  prismaMock.salesCampaign.groupBy.mockResolvedValue([]);
  prismaMock.actionProposal.findMany.mockResolvedValue([]);
  prismaMock.salesTask.findMany.mockResolvedValue([]);
});

/** 재진행 후보 1건(d1)이 나오도록 최소 데이터를 깐다. */
const arrangeRerunCandidate = () => {
  prismaMock.deal.findMany.mockImplementation((args: { where?: unknown }) =>
    args?.where
      ? Promise.resolve([
          {
            id: "d1",
            dealName: "딜",
            brandName: "브랜드",
            partnerId: "p1",
            status: "ARCHIVED",
            createdAt: new Date(Date.now() - 30 * DAY_MS),
          },
        ])
      : Promise.resolve([{ id: "d1", partnerId: "p1" }]),
  );
  prismaMock.salesCampaign.groupBy.mockResolvedValue([
    {
      sellerId: "s1",
      dealId: "d1",
      groupId: null,
      _count: { _all: 1 },
      _max: { startDate: new Date(Date.now() - 200 * DAY_MS) },
      _sum: { actualSales: 12_000_000 },
    },
  ]);
};

describe("GET /api/sellers/[id]/deal-candidates", () => {
  it("미인증이면 인증 응답을 그대로 돌려준다", async () => {
    const denied = new Response(null, { status: 401 });
    vi.mocked(requireAuth).mockResolvedValue({
      authenticated: false,
      response: denied,
    } as never);
    await expect(GET(new Request("http://t"), ctx("s1"))).resolves.toBe(denied);
  });

  it("없는 셀러는 404", async () => {
    prismaMock.seller.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://t"), ctx("nope"))).status).toBe(404);
  });

  // 🪤 ARCHIVED 라벨은 "완료"이고 DROPPED 는 "보류"다. 완료 딜은 D3 재진행의 주
  // 모집단이라 풀에서 빼면 안 되고, 판단은 `isLive` 축으로 SSOT 가 한다.
  it("보류 딜만 풀에서 뺀다 — 완료 딜은 재진행 모집단이라 남긴다", async () => {
    await GET(new Request("http://t"), ctx("s1"));
    expect(poolCall().where.status.notIn).toEqual(["DROPPED"]);
    expect(poolCall().where.status.in).toBeUndefined();
  });

  it("살아 있는 딜에만 isLive 를 붙여 SSOT 에 넘긴다", async () => {
    prismaMock.deal.findMany.mockImplementation((args: { where?: unknown }) =>
      args?.where
        ? Promise.resolve([
            { id: "live", dealName: "협의 중", brandName: null, partnerId: null, status: "NEGOTIATING", createdAt: new Date() },
            { id: "done", dealName: "완료", brandName: null, partnerId: null, status: "ARCHIVED", createdAt: new Date() },
          ])
        : Promise.resolve([]),
    );
    const body = await (await GET(new Request("http://t"), ctx("s1"))).json();
    // 접점 없는 완료 딜은 SSOT 가 떨어뜨리고, 살아 있는 딜만 남는다.
    expect(body.candidates.map((c: { dealId: string }) => c.dealId)).toEqual(["live"]);
  });

  it("옵션 딜은 후보 풀에서 뺀다 (본품 단위로 제안한다)", async () => {
    await GET(new Request("http://t"), ctx("s1"));
    expect(poolCall().where.parentDealId).toBeNull();
  });

  it("집계는 이 셀러 · 실행 상태 · 시작일 도래분으로 좁힌다", async () => {
    await GET(new Request("http://t"), ctx("s1"));
    const where = prismaMock.salesCampaign.groupBy.mock.calls[0][0].where;
    expect(where.sellerId).toBe("s1");
    expect(where.status.in).toContain("COMPLETED");
    expect(where.startDate.lte).toBeInstanceOf(Date);
  });

  it("전에 진행했고 간격이 지난 딜은 재진행 후보로 올라온다", async () => {
    arrangeRerunCandidate();
    const body = await (await GET(new Request("http://t"), ctx("s1"))).json();
    expect(body.candidates[0]).toMatchObject({
      dealId: "d1",
      reason: "SAME_DEAL_RERUN",
      priority: true,
      proposed: false,
    });
  });

  // --- '기안됨' 표시는 dedup 키 단위다 (2단계) ---

  it("같은 (셀러·사유·딜) 기안이 열려 있으면 proposed 로 내려간다", async () => {
    arrangeRerunCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" } },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("s1"))).json();
    expect(body.candidates[0].proposed).toBe(true);
  });

  // 🔴 두 방향의 모수가 어긋나면 목록은 후보로 보여주는데 기안 라우트가 409 로 거절한다.
  it("이미 아웃리치가 있는 딜은 후보에서 빠진다 (딜→셀러 방향과 같은 제외)", async () => {
    arrangeRerunCandidate();
    prismaMock.salesTask.findMany.mockResolvedValue([{ dealId: "d1" }]);
    const body = await (await GET(new Request("http://t"), ctx("s1"))).json();
    expect(body.candidates).toHaveLength(0);
  });

  it("다른 딜의 기안은 이 딜을 막지 않는다 (과차단 방지)", async () => {
    arrangeRerunCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "other" } },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("s1"))).json();
    expect(body.candidates[0].proposed).toBe(false);
  });
});
