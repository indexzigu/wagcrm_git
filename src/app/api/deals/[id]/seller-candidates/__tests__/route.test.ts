// 라우트 계약 — 인증 필수 · 없는 딜 404 · 이미 연결된 셀러 제외 · alias 우선 표기 ·
// 매출 미입력이 0 으로 내려가지 않음 · 집계 where 에 실행 상태와 시작일 도래 조건이 걸림.
//
// ⏰ 고정 날짜 픽스처 금지 — 경과일은 `Date.now()` 기준 상대 오프셋으로 만든다.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY_MS = 86_400_000;

const prismaMock = {
  deal: { findUnique: vi.fn(), findMany: vi.fn() },
  seller: { findMany: vi.fn() },
  salesCampaign: { groupBy: vi.fn() },
  salesTask: { findMany: vi.fn() },
  actionProposal: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/api-auth", () => ({ requireAuth: vi.fn() }));

import { GET } from "../route";
import { requireAuth } from "@/lib/api-auth";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const runRow = (over: Record<string, unknown> = {}) => ({
  sellerId: "s1",
  dealId: "d9",
  groupId: null,
  _count: { _all: 1 },
  _max: { startDate: new Date(Date.now() - 200 * DAY_MS) },
  _sum: { actualSales: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ authenticated: true, context: {} } as never);
  prismaMock.deal.findUnique.mockResolvedValue({ id: "d1", partnerId: "p1" });
  prismaMock.deal.findMany.mockResolvedValue([{ id: "d1", partnerId: "p1" }]);
  prismaMock.salesCampaign.groupBy.mockResolvedValue([]);
  prismaMock.salesTask.findMany.mockResolvedValue([]);
  prismaMock.seller.findMany.mockResolvedValue([]);
  prismaMock.actionProposal.findMany.mockResolvedValue([]);
});

const oneSeller = () =>
  prismaMock.seller.findMany.mockResolvedValue([
    {
      id: "s1",
      name: "셀러",
      alias: null,
      snsHandle: "h",
      snsType: "INSTAGRAM",
      fitLevel: null,
      currentFollowers: 1,
    },
  ]);

describe("GET /api/deals/[id]/seller-candidates", () => {
  it("미인증이면 인증 응답을 그대로 돌려준다", async () => {
    const denied = new Response(null, { status: 401 });
    vi.mocked(requireAuth).mockResolvedValue({
      authenticated: false,
      response: denied,
    } as never);
    await expect(GET(new Request("http://t"), ctx("d1"))).resolves.toBe(denied);
    expect(prismaMock.deal.findUnique).not.toHaveBeenCalled();
  });

  it("없는 딜은 404", async () => {
    prismaMock.deal.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://t"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("집계는 실행 상태 + 시작일 도래분만 센다", async () => {
    await GET(new Request("http://t"), ctx("d1"));
    const where = prismaMock.salesCampaign.groupBy.mock.calls[0][0].where;
    expect(where.status.in).toContain("COMPLETED");
    expect(where.status.in).not.toContain("PROPOSAL");
    expect(where.startDate.lte).toBeInstanceOf(Date);
  });

  it("alias 가 있으면 alias 로 표기한다 (P2)", async () => {
    prismaMock.seller.findMany.mockResolvedValue([
      {
        id: "s1",
        name: "실명자리",
        alias: "별칭",
        snsHandle: "h",
        snsType: "INSTAGRAM",
        fitLevel: null,
        currentFollowers: 100,
      },
    ]);
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    const res = await GET(new Request("http://t"), ctx("d1"));
    const body = await res.json();
    expect(body.candidates[0].name).toBe("별칭");
  });

  it("쌍 매출 미입력은 null 로 내려간다 — 0 이 아니다", async () => {
    prismaMock.seller.findMany.mockResolvedValue([
      {
        id: "s1",
        name: "셀러",
        alias: null,
        snsHandle: "h",
        snsType: "INSTAGRAM",
        fitLevel: null,
        currentFollowers: 1,
      },
    ]);
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates[0].pairSalesTotal).toBeNull();
  });

  it("이미 연결된 셀러는 후보에서 빠진다", async () => {
    prismaMock.seller.findMany.mockResolvedValue([
      {
        id: "s1",
        name: "셀러",
        alias: null,
        snsHandle: "h",
        snsType: "INSTAGRAM",
        fitLevel: null,
        currentFollowers: 1,
      },
    ]);
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    prismaMock.salesTask.findMany.mockResolvedValue([{ sellerId: "s1" }]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates).toHaveLength(0);
  });

  it("진행 이력이 없는 셀러는 후보가 아니다 (D1 스코프)", async () => {
    prismaMock.seller.findMany.mockResolvedValue([
      {
        id: "cold",
        name: "발굴 리스트",
        alias: null,
        snsHandle: "h",
        snsType: "INSTAGRAM",
        fitLevel: null,
        currentFollowers: 1,
      },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates).toHaveLength(0);
  });

  // --- '기안됨' 표시는 셀러 단위가 아니라 dedup 키 단위다 (2단계) ---

  it("같은 (셀러·사유·딜) 기안이 열려 있으면 proposed 로 내려간다", async () => {
    oneSeller();
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "LONG_GAP_SELLER", dealId: "d1" } },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates[0]).toMatchObject({ reason: "LONG_GAP_SELLER", proposed: true });
  });

  it("같은 셀러라도 **다른 딜**의 기안은 이 딜을 막지 않는다 (과차단 방지)", async () => {
    oneSeller();
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "LONG_GAP_SELLER", dealId: "other" } },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates[0].proposed).toBe(false);
  });

  it("케이던스 기안(딜 없음)도 이 딜을 막지 않는다", async () => {
    oneSeller();
    prismaMock.salesCampaign.groupBy.mockResolvedValue([runRow()]);
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "CADENCE_DUE", dealId: null } },
    ]);
    const body = await (await GET(new Request("http://t"), ctx("d1"))).json();
    expect(body.candidates[0].proposed).toBe(false);
  });
});
