// 기안 승격 라우트 계약 (D2 2단계).
//
// 이 라우트가 지켜야 하는 것 3가지:
//   ① 인증 게이트
//   ② **서버 권위 재계산** — 후보 자격과 사유 코드를 서버가 정한다(클라이언트 값 불신).
//      사유는 dedup 키의 축이라, 클라이언트가 정하게 두면 키를 우회할 수 있다.
//   ③ **중복 제거는 `셀러id + 사유코드 + 딜id` 단위** — 셀러 단독 키는 딜 차원이 들어온
//      뒤로 과차단이다.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY_MS = 86_400_000;

const prismaMock = {
  deal: { findUnique: vi.fn(), findMany: vi.fn() },
  seller: { findMany: vi.fn() },
  salesCampaign: { groupBy: vi.fn(), findMany: vi.fn() },
  salesTask: { findMany: vi.fn() },
  actionProposal: { findMany: vi.fn() },
};

const createMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/api-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/cache-tags", () => ({ revalidateMasterDataCaches: vi.fn() }));
vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: { create: (...args: unknown[]) => createMock(...args) },
}));

import { POST } from "../route";
import { requireAuth } from "@/lib/api-auth";

const post = (body: unknown) =>
  POST(
    new Request("http://t", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );

/** 이 셀러가 이 딜의 후보가 되도록 최소 데이터를 깐다 (오래 멈춘 셀러 = LONG_GAP_SELLER). */
const arrangeDealCandidate = () => {
  prismaMock.deal.findUnique.mockResolvedValue({ id: "d1", partnerId: "p1", dealName: "딜 이름" });
  prismaMock.deal.findMany.mockResolvedValue([{ id: "d9", partnerId: null }]);
  prismaMock.seller.findMany.mockResolvedValue([
    {
      id: "s1",
      name: "실명자리",
      alias: "별칭",
      snsHandle: "h",
      snsType: "INSTAGRAM",
      fitLevel: null,
      currentFollowers: 1,
    },
  ]);
  prismaMock.salesCampaign.groupBy.mockResolvedValue([
    {
      sellerId: "s1",
      dealId: "d9",
      groupId: null,
      _count: { _all: 1 },
      _max: { startDate: new Date(Date.now() - 200 * DAY_MS) },
      _sum: { actualSales: null },
    },
  ]);
  prismaMock.salesTask.findMany.mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ authenticated: true, context: {} } as never);
  prismaMock.actionProposal.findMany.mockResolvedValue([]);
  prismaMock.salesCampaign.findMany.mockResolvedValue([]);
  createMock.mockResolvedValue({ id: "proposal-1", title: "t" });
});

describe("POST /api/recampaign-proposals — 공통", () => {
  it("미인증이면 인증 응답을 그대로 돌려준다", async () => {
    const denied = new Response(null, { status: 401 });
    vi.mocked(requireAuth).mockResolvedValue({
      authenticated: false,
      response: denied,
    } as never);
    await expect(post({ sellerId: "s1" })).resolves.toBe(denied);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sellerId 가 없으면 400", async () => {
    expect((await post({})).status).toBe(400);
  });
});

describe("딜 스코프 기안", () => {
  it("후보가 아니면 409 이고 기안하지 않는다 (서버 권위 재계산)", async () => {
    arrangeDealCandidate();
    prismaMock.salesCampaign.groupBy.mockResolvedValue([]); // 진행 이력 0 → D1 스코프 밖
    const res = await post({ sellerId: "s1", dealId: "d1" });
    expect(res.status).toBe(409);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("없는 딜이면 404", async () => {
    arrangeDealCandidate();
    prismaMock.deal.findUnique.mockResolvedValue(null);
    expect((await post({ sellerId: "s1", dealId: "nope" })).status).toBe(404);
  });

  it("사유 코드는 클라이언트가 아니라 서버가 정한다", async () => {
    arrangeDealCandidate();
    // 클라이언트가 다른 사유를 우겨넣어도 무시된다 — 사유는 dedup 키의 축이다.
    const res = await post({ sellerId: "s1", dealId: "d1", reason: "SAME_DEAL_RERUN" });
    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0][0].structuredResult).toMatchObject({
      reason: "LONG_GAP_SELLER",
      dealId: "d1",
    });
  });

  it("기안에 딜 이름과 alias 표기를 담는다 (P2)", async () => {
    arrangeDealCandidate();
    await post({ sellerId: "s1", dealId: "d1" });
    expect(createMock.mock.calls[0][0].title).toContain("별칭");
    expect(createMock.mock.calls[0][0].title).toContain("딜 이름");
  });
});

describe("중복 제거 — 셀러 단독이 아니라 (셀러·사유·딜) 단위", () => {
  it("같은 조합의 열린 기안이 있으면 새로 만들지 않는다", async () => {
    arrangeDealCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        id: "old",
        targetEntityId: "s1",
        structuredResult: { reason: "LONG_GAP_SELLER", dealId: "d1" },
      },
    ]);
    const res = await post({ sellerId: "s1", dealId: "d1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, proposalId: "old" });
    expect(createMock).not.toHaveBeenCalled();
  });

  // 🔴 2단계의 존재 이유 — 종전 셀러 단독 키에서는 이 케이스가 통째로 막혔다.
  it("같은 셀러라도 **다른 딜**의 열린 기안은 막지 않는다", async () => {
    arrangeDealCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        id: "other-deal",
        targetEntityId: "s1",
        structuredResult: { reason: "LONG_GAP_SELLER", dealId: "other" },
      },
    ]);
    expect((await post({ sellerId: "s1", dealId: "d1" })).status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("케이던스 기안이 열려 있어도 딜 기안은 막지 않는다", async () => {
    arrangeDealCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { id: "cadence", targetEntityId: "s1", structuredResult: { reason: "CADENCE_DUE", dealId: null } },
    ]);
    expect((await post({ sellerId: "s1", dealId: "d1" })).status).toBe(201);
  });

  // 🔴 실측 사고 — SQLite 에서는 리포지토리가 Json 을 **문자열로** 저장하고, 이 라우트는
  // raw Prisma 로 읽는다. 객체만 처리하면 로컬에서 dedup 이 조용히 뚫린다.
  it("문자열로 저장된 structuredResult 도 중복으로 잡는다 (SQLite 직렬화)", async () => {
    arrangeDealCandidate();
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        id: "old",
        targetEntityId: "s1",
        structuredResult: JSON.stringify({ reason: "LONG_GAP_SELLER", dealId: "d1" }),
      },
    ]);
    const res = await post({ sellerId: "s1", dealId: "d1" });
    expect(await res.json()).toMatchObject({ skipped: true, proposalId: "old" });
    expect(createMock).not.toHaveBeenCalled();
  });

  // 🔴 dedup 을 넓히면서 뚫리기 쉬운 자리 — 딜 축 도입 이전 행에는 reason 이 없다.
  it("사유가 없는 레거시 행은 여전히 케이던스 기안을 막는다", async () => {
    prismaMock.salesCampaign.findMany.mockResolvedValue([
      {
        sellerId: "s1",
        startDate: new Date(Date.now() - 400 * DAY_MS),
        endDate: new Date(Date.now() - 390 * DAY_MS),
        status: "COMPLETED",
        seller: { name: "셀러", alias: null, availabilityNote: null },
      },
      {
        sellerId: "s1",
        startDate: new Date(Date.now() - 200 * DAY_MS),
        endDate: new Date(Date.now() - 190 * DAY_MS),
        status: "COMPLETED",
        seller: { name: "셀러", alias: null, availabilityNote: null },
      },
    ]);
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { id: "legacy", targetEntityId: "s1", structuredResult: { cadenceDays: 200 } },
    ]);
    const res = await post({ sellerId: "s1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, proposalId: "legacy" });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("케이던스 기안 (딜 없음) — 기존 계약 유지", () => {
  it("적기 대상이 아니면 409", async () => {
    const res = await post({ sellerId: "s1" });
    expect(res.status).toBe(409);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("DUE 셀러는 사유 CADENCE_DUE·딜 없음으로 기안된다", async () => {
    prismaMock.salesCampaign.findMany.mockResolvedValue([
      {
        sellerId: "s1",
        startDate: new Date(Date.now() - 400 * DAY_MS),
        endDate: new Date(Date.now() - 390 * DAY_MS),
        status: "COMPLETED",
        seller: { name: "셀러", alias: null, availabilityNote: null },
      },
      {
        sellerId: "s1",
        startDate: new Date(Date.now() - 200 * DAY_MS),
        endDate: new Date(Date.now() - 190 * DAY_MS),
        status: "COMPLETED",
        seller: { name: "셀러", alias: null, availabilityNote: null },
      },
    ]);
    const res = await post({ sellerId: "s1" });
    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0][0].structuredResult).toMatchObject({
      reason: "CADENCE_DUE",
      dealId: null,
    });
  });
});
