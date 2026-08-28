// 재캠페인 적기 알림 라우트 계약.
//
// 🔴 이 파일이 지키는 핵심은 `proposedSellerIds` 의 **모수**다. 같은 `requestType` 을
// 딜 스코프 기안(D2 2단계)도 쓰기 때문에, 셀러 id 만 보고 '기안됨'을 판정하면
// "이 셀러에게 어떤 딜을 제안하는 기안"이 열려 있다는 이유로 케이던스 카드의 기안 버튼이
// 사라진다 — 정작 케이던스 기안은 만들어진 적이 없는데도.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY_MS = 86_400_000;

const prismaMock = {
  salesCampaign: { findMany: vi.fn() },
  actionProposal: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));

import { GET } from "../route";

/** 케이던스 적기(DUE)가 되도록 오래된 진행 2건을 깐다. */
const arrangeDueSeller = () =>
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

beforeEach(() => {
  vi.clearAllMocks();
  arrangeDueSeller();
  prismaMock.actionProposal.findMany.mockResolvedValue([]);
});

describe("GET /api/recampaign-alerts", () => {
  it("적기 셀러를 알림으로 낸다", async () => {
    const body = await (await GET()).json();
    expect(body.alerts.map((a: { sellerId: string }) => a.sellerId)).toContain("s1");
    expect(body.proposedSellerIds).toEqual([]);
  });

  it("케이던스 기안이 열려 있으면 '기안됨'으로 센다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "CADENCE_DUE", dealId: null } },
    ]);
    const body = await (await GET()).json();
    expect(body.proposedSellerIds).toEqual(["s1"]);
  });

  it("사유가 없는 레거시 행도 케이던스 기안으로 센다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { cadenceDays: 200 } },
    ]);
    const body = await (await GET()).json();
    expect(body.proposedSellerIds).toEqual(["s1"]);
  });

  // 🔴 회귀 지점 — 딜 기안이 케이던스 카드의 버튼을 뺏으면 안 된다.
  it("딜 스코프 기안은 이 카드의 '기안됨'에 포함하지 않는다", async () => {
    prismaMock.actionProposal.findMany.mockResolvedValue([
      { targetEntityId: "s1", structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" } },
    ]);
    const body = await (await GET()).json();
    expect(body.proposedSellerIds).toEqual([]);
  });

  it("조회 실패는 500 으로 표면화한다 (에러를 삼키지 않는다)", async () => {
    prismaMock.salesCampaign.findMany.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
