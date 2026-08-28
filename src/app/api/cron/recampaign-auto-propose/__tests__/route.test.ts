// 재진행 적기 자동 기안 크론 계약.
//
// 이 라우트가 지켜야 하는 것:
//   ① 인증 — 공유 시크릿 SSOT(`@/lib/cron-auth`). 미인증은 아무것도 쓰지 않는다
//   ② 발화 게이트 — 재진행 도래 + D3 매출 문턱. 화면 규칙(전부 표시)과 모수가 다르다
//   ③ 멱등성 — 열린 기안·쿨다운은 건너뛴다. 상한 절단은 응답에 드러난다
//   ④ 마지막 실행 마커 — withSystemTaskStatus 로 감싼다
//
// ⏰ 고정 날짜 픽스처 금지(P9) — 상대 오프셋으로 만든다.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY_MS = 86_400_000;

const prismaMock = {
  salesCampaign: { groupBy: vi.fn() },
  deal: { findMany: vi.fn() },
  seller: { findMany: vi.fn() },
  salesTask: { findMany: vi.fn() },
  actionProposal: { findMany: vi.fn() },
};
const createMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
vi.mock("@/lib/cache-tags", () => ({ revalidateMasterDataCaches: vi.fn() }));
vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: { create: (...a: unknown[]) => createMock(...a) },
}));
// 🪤 목을 **실제 시그니처와 같게** 둔다 — 래퍼는 Response 가 아니라 "핸들러를 감싼 함수"를
// 돌려준다. 목이 곧바로 실행해 Response 를 주면 라우트가 함수를 반환하는 결함을 가린다
// (실제로 그렇게 짰다가 타입 검사에서 잡혔다).
// ⚠️ `vi.hoisted` 가 필요하다 — 라우트가 **모듈 로드 시점**에 래퍼를 부르므로(올바른 패턴)
// 평범한 const 는 아직 초기화 전이다(TDZ).
const { wrapped } = vi.hoisted(() => ({ wrapped: [] as string[] }));
vi.mock("@/lib/system-task-status", () => ({
  withSystemTaskStatus: (jobKey: string, fn: (request: Request) => Promise<Response>) => {
    wrapped.push(jobKey);
    return (request: Request) => fn(request);
  },
}));

import { GET } from "../route";
import { verifyCronAuth } from "@/lib/cron-auth";

const req = () => new Request("http://t/api/cron/recampaign-auto-propose");

/** 재진행 도래 + 매출 문턱 통과 쌍 하나를 깐다. */
const arrangeOneCandidate = (over: { sales?: number | null; daysAgo?: number } = {}) => {
  prismaMock.salesCampaign.groupBy.mockResolvedValue([
    {
      sellerId: "s1",
      dealId: "d1",
      groupId: null,
      _count: { _all: 2 },
      _max: { startDate: new Date(Date.now() - (over.daysAgo ?? 200) * DAY_MS) },
      _sum: { actualSales: over.sales === undefined ? 12_000_000 : over.sales },
    },
  ]);
  prismaMock.deal.findMany.mockResolvedValue([
    { id: "d1", dealName: "딜 이름", partnerId: "p1" },
  ]);
  prismaMock.seller.findMany.mockResolvedValue([{ id: "s1", name: "실명자리", alias: "별칭" }]);
  prismaMock.salesTask.findMany.mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyCronAuth).mockReturnValue(true);
  prismaMock.actionProposal.findMany.mockResolvedValue([]);
  createMock.mockImplementation(async () => ({ id: `p${createMock.mock.calls.length}` }));
  arrangeOneCandidate();
});

describe("① 인증", () => {
  it("시크릿이 맞지 않으면 401 이고 아무것도 조회·생성하지 않는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(prismaMock.salesCampaign.groupBy).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("④ 마지막 실행 마커", () => {
  // 모듈 로드 시점에 한 번 감싸진다 — 요청마다가 아니라 export 시점의 사실이다.
  it("이 잡 키로 withSystemTaskStatus 에 감싸여 export 된다", () => {
    expect(wrapped).toEqual(["recampaign-auto-propose"]);
  });
});

describe("② 발화 게이트", () => {
  it("도래 + 문턱 통과 조합을 기안한다", async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ checked: 1, created: 1, droppedByCap: 0 });
    const input = createMock.mock.calls[0][0];
    expect(input.structuredResult).toMatchObject({ reason: "SAME_DEAL_RERUN", dealId: "d1" });
    expect(input.title).toContain("별칭"); // P2 alias 우선
    expect(input.title).toContain("딜 이름");
  });

  it("아직 도래하지 않은 조합은 기안하지 않는다", async () => {
    arrangeOneCandidate({ daysAgo: 30 });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ checked: 0, created: 0 });
    expect(createMock).not.toHaveBeenCalled();
  });

  // 🔴 오너 확정(2026-08-04): 자동 발화는 D3 문턱 이상만. 화면에는 미만도 전부 보인다.
  it("매출 문턱 미만은 자동 발화하지 않는다", async () => {
    arrangeOneCandidate({ sales: 9_999_999 });
    expect((await (await GET(req())).json()).created).toBe(0);
  });

  it("매출 미입력은 0 이 아니라 판정 보류다 — 게이트를 통과시키지 않는다", async () => {
    arrangeOneCandidate({ sales: null });
    expect((await (await GET(req())).json()).created).toBe(0);
  });

  it("이미 아웃리치가 있는 조합은 제외한다", async () => {
    prismaMock.salesTask.findMany.mockResolvedValue([{ sellerId: "s1", dealId: "d1" }]);
    expect((await (await GET(req())).json()).created).toBe(0);
  });

  it("보류 딜은 후보 풀에서 뺀다", async () => {
    await GET(req());
    const where = prismaMock.deal.findMany.mock.calls[0][0].where;
    expect(where.status.notIn).toEqual(["DROPPED"]);
    expect(where.parentDealId).toBeNull();
  });
});

describe("③ 멱등성", () => {
  it("같은 조합의 열린 기안이 있으면 건너뛴다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        targetEntityId: "s1",
        structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" },
        status: "PENDING_APPROVAL",
        updatedAt: new Date(Date.now() - 999 * DAY_MS),
      },
    ]);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ created: 0, skippedOpen: 1, skippedCooldown: 0 });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("어제 거부된 기안은 쿨다운 안이라 건너뛴다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        targetEntityId: "s1",
        structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" },
        status: "REJECTED",
        updatedAt: new Date(Date.now() - 1 * DAY_MS),
      },
    ]);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ created: 0, skippedCooldown: 1 });
  });

  it("쿨다운이 지난 이력은 다시 기안한다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        targetEntityId: "s1",
        structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" },
        status: "REJECTED",
        updatedAt: new Date(Date.now() - 120 * DAY_MS),
      },
    ]);
    expect((await (await GET(req())).json()).created).toBe(1);
  });

  // 🪤 SQLite 는 Json 을 문자열로 저장한다 — 객체만 처리하면 로컬에서 멱등성이 뚫린다.
  it("문자열로 저장된 structuredResult 도 같은 키로 읽는다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        targetEntityId: "s1",
        structuredResult: JSON.stringify({ reason: "SAME_DEAL_RERUN", dealId: "d1" }),
        status: "PENDING_APPROVAL",
        updatedAt: new Date(),
      },
    ]);
    expect((await (await GET(req())).json()).skippedOpen).toBe(1);
  });

  it("다른 딜의 기안은 이 조합을 막지 않는다 (과차단 방지)", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      {
        targetEntityId: "s1",
        structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "other" },
        status: "PENDING_APPROVAL",
        updatedAt: new Date(),
      },
    ]);
    expect((await (await GET(req())).json()).created).toBe(1);
  });

  it("이력 조회는 닫힌 상태까지 포함한다 ('이미 처리' 집합)", async () => {
    await GET(req());
    const statuses = prismaMock.actionProposal.findMany.mock.calls[0][0].where.status.in;
    expect(statuses).toEqual(expect.arrayContaining(["REJECTED", "EXECUTED", "PENDING_APPROVAL"]));
  });
});

describe("상한", () => {
  it("상한을 넘으면 잘라내고 빠진 수를 응답에 남긴다", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      sellerId: "s1",
      dealId: `d${i}`,
      groupId: null,
      _count: { _all: 1 },
      _max: { startDate: new Date(Date.now() - (200 + i) * DAY_MS) },
      _sum: { actualSales: 12_000_000 },
    }));
    prismaMock.salesCampaign.groupBy.mockResolvedValue(many);
    prismaMock.deal.findMany.mockResolvedValue(
      many.map((m) => ({ id: m.dealId, dealName: `딜${m.dealId}`, partnerId: "p1" })),
    );
    const body = await (await GET(req())).json();
    expect(body.created).toBe(10);
    expect(body.droppedByCap).toBe(2);
    expect(createMock).toHaveBeenCalledTimes(10);
  });
});
