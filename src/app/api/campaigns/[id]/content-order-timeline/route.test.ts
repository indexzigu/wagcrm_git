import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const campaignFindMany = vi.fn();
const assetFindMany = vi.fn();
const storyFindMany = vi.fn();
const storyCount = vi.fn();
const getMobileCampaignSales = vi.fn();
const getMobileCampaignGroupSales = vi.fn();
const loadSuggestedPosts = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique, findMany: campaignFindMany },
    asset: { findMany: assetFindMany },
    sellerStorySnapshot: { findMany: storyFindMany, count: storyCount },
  }),
}));
// 후보 수는 자료관리와 **같은 SSOT** 로 세야 한다 — 이 목이 그 위임을 검증한다.
vi.mock("@/lib/campaign-suggested-posts-loader", () => ({
  loadSuggestedPosts: (...a: unknown[]) => loadSuggestedPosts(...a),
}));
vi.mock("@/lib/mobile-campaign-sales", () => ({
  getMobileCampaignSales: (...a: unknown[]) => getMobileCampaignSales(...a),
  getMobileCampaignGroupSales: (...a: unknown[]) => getMobileCampaignGroupSales(...a),
}));

async function callGet(id = "camp-1") {
  const { GET } = await import("./route");
  return GET(new Request("http://test.local"), { params: Promise.resolve({ id }) });
}

type StoryRow = {
  id: string;
  sellerId: string;
  classification: string;
  salesCampaignId: string | null;
  takenAt: Date;
  thumbnailUrl: string | null;
};

/** storyFindMany 목이 실제 prisma where 시맨틱(sellerId/classification/OR/takenAt 범위)을 따르게
 * 흉내내는 헬퍼 — Finding B·C가 실제로 라우트가 넘긴 where로 걸러지는지(단언 대상 문자열이 아니라
 * 동작)를 검증하기 위함이다. */
function applyStoryWhere(rows: StoryRow[], where: Record<string, unknown>) {
  return rows.filter((r) => {
    if (where.sellerId && r.sellerId !== where.sellerId) return false;
    if (where.classification && r.classification !== where.classification) return false;
    const or = where.OR as
      | Array<{ salesCampaignId?: string | null | { in: string[] } }>
      | undefined;
    if (
      or &&
      !or.some((cond) => {
        const target = cond.salesCampaignId;
        if (target && typeof target === "object" && "in" in target) {
          return r.salesCampaignId !== null && target.in.includes(r.salesCampaignId);
        }
        return r.salesCampaignId === target;
      })
    ) {
      return false;
    }
    const takenAt = where.takenAt as { gte?: Date; lte?: Date } | undefined;
    if (takenAt?.gte && r.takenAt.getTime() < takenAt.gte.getTime()) return false;
    if (takenAt?.lte && r.takenAt.getTime() > takenAt.lte.getTime()) return false;
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  findUnique.mockResolvedValue({
    id: "camp-1",
    sellerId: "seller-1",
    groupId: null,
    orderCampaignId: "oc-1",
    startDate: new Date("2026-07-01T00:00:00+09:00"),
    endDate: new Date("2026-07-03T00:00:00+09:00"),
  });
  campaignFindMany.mockResolvedValue([]);
  assetFindMany.mockResolvedValue([]);
  storyFindMany.mockResolvedValue([]);
  storyCount.mockResolvedValue(0);
  loadSuggestedPosts.mockResolvedValue({
    suggestions: [],
    lastCollectedAt: null,
    sharedCampaignIds: ["camp-1"],
    reviewClosed: false,
  });
  getMobileCampaignSales.mockResolvedValue({
    source: "live",
    daily: [{ date: "2026-07-02", orders: 5, revenue: 50000 }],
    intraday: { points: [{ startMs: 1, orders: 5, revenue: 50000 }], daysWithoutBuckets: [] },
  });
  getMobileCampaignGroupSales.mockResolvedValue({
    source: "live",
    daily: [{ date: "2026-07-02", orders: 5, revenue: 50000 }],
    intraday: { points: [{ startMs: 2, orders: 9, revenue: 90000 }], daysWithoutBuckets: [] },
  });
});

describe("content-order-timeline GET", () => {
  it("캠페인 미존재 시 404", async () => {
    findUnique.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("캠페인을 찾을 수 없습니다.");
  });

  it("startDate가 없어 창을 확정할 수 없으면 422", async () => {
    findUnique.mockResolvedValue({
      id: "camp-1",
      sellerId: "seller-1",
      startDate: null,
      endDate: new Date("2026-07-03T00:00:00+09:00"),
    });
    const res = await callGet();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("캠페인 시작일이 설정되지 않았습니다.");
  });

  it("asset select는 타임라인 필요 필드만 — orders 블롭류 광폭 select 금지(egress 계약)", async () => {
    await callGet();
    const arg = assetFindMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      entityType: "CAMPAIGN",
      entityId: { in: ["camp-1"] },
      provider: "EXTERNAL_LINK",
      archivedAt: null,
      postedAt: { not: null },
    });
    expect(arg.select).toEqual({
      id: true, mediaType: true, postedAt: true, thumbnailUrl: true,
      externalUrl: true, likeCount: true, commentCount: true, likesHidden: true,
    });
    const storyArg = storyFindMany.mock.calls[0][0];
    expect(storyArg.where).toMatchObject({
      sellerId: "seller-1",
      classification: "CAMPAIGN",
      OR: [{ salesCampaignId: null }, { salesCampaignId: { in: ["camp-1"] } }],
    });
    expect(storyArg.select).toEqual({
      id: true, takenAt: true, thumbnailUrl: true,
    });
  });

  it("타 캠페인에 명시 분류된 스토리는 배제하고 미분류·이 캠페인 스토리만 포함한다(Finding B)", async () => {
    const rows: StoryRow[] = [
      {
        id: "s-unclassified", sellerId: "seller-1", classification: "CAMPAIGN",
        salesCampaignId: null, takenAt: new Date("2026-07-02T10:00:00+09:00"),
        thumbnailUrl: null,
      },
      {
        id: "s-own", sellerId: "seller-1", classification: "CAMPAIGN",
        salesCampaignId: "camp-1", takenAt: new Date("2026-07-02T11:00:00+09:00"),
        thumbnailUrl: null,
      },
      {
        id: "s-other-campaign", sellerId: "seller-1", classification: "CAMPAIGN",
        salesCampaignId: "camp-2-sibling", takenAt: new Date("2026-07-02T12:00:00+09:00"),
        thumbnailUrl: null,
      },
    ];
    storyFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      applyStoryWhere(rows, args.where),
    );
    const res = await callGet();
    const body = await res.json();
    const day = body.days.find((d: { date: string }) => d.date === "2026-07-02");
    const storyIds = day.events
      .filter((e: { source: string }) => e.source === "story")
      .map((e: { id: string }) => e.id);
    expect(storyIds).toEqual(expect.arrayContaining(["story-s-unclassified", "story-s-own"]));
    expect(storyIds).not.toContain("story-s-other-campaign");
    expect(storyIds).toHaveLength(2);
  });

  it("startDate가 UTC 자정(날짜경계)으로 저장돼도 첫날 새벽 스토리를 놓치지 않는다(Finding C, 창 시작 KST 보정)", async () => {
    findUnique.mockResolvedValue({
      id: "camp-1",
      sellerId: "seller-1",
      // UTC 자정 = KST 09:00 — 날짜경계. 보정 없이 그대로 gte로 쓰면 첫날 00:00~08:59에 찍힌
      // 스토리가 필터에서 잘려나간다(인스타 심야 발행이 흔함).
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-03T00:00:00+09:00"),
    });
    const rows: StoryRow[] = [
      {
        id: "s-dawn", sellerId: "seller-1", classification: "CAMPAIGN",
        salesCampaignId: null, takenAt: new Date("2026-07-01T02:00:00+09:00"),
        thumbnailUrl: null,
      },
    ];
    storyFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      applyStoryWhere(rows, args.where),
    );
    const res = await callGet();
    const body = await res.json();
    const day = body.days.find((d: { date: string }) => d.date === "2026-07-01");
    expect(day).toBeDefined();
    expect(
      day.events.some((e: { id: string }) => e.id === "story-s-dawn"),
    ).toBe(true);
  });

  it("endDate가 날짜경계(자정)로 저장돼 있어도 마감일 당일 스토리를 놓치지 않는다(KST 종일 보정)", async () => {
    // endDate = "2026-07-03T00:00:00+09:00" (KST 자정, 날짜경계) — 보정 없이 그대로 lte로 쓰면
    // 마감 당일 오후에 찍힌 스토리(예: 14:00 KST)가 필터에서 잘려나간다.
    await callGet();
    const storyArg = storyFindMany.mock.calls[0][0];
    const lte = storyArg.where.takenAt.lte as Date;
    expect(lte.toISOString()).toBe(new Date("2026-07-03T23:59:59.999+09:00").toISOString());
  });

  it("창 전 일자를 열거하고 daily·이벤트를 병합해 응답한다", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("live");
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03",
    ]);
    expect(body.days[1].orders).toBe(5);
  });

  it("누적 주문을 창 시작부터 단조 누계로 함께 내린다(차트 누적 곡선 계열)", async () => {
    getMobileCampaignSales.mockResolvedValue({
      source: "live",
      daily: [
        { date: "2026-07-01", orders: 2, revenue: 1 },
        { date: "2026-07-03", orders: 4, revenue: 1 },
      ],
    });
    const res = await callGet();
    const body = await res.json();
    expect(body.days.map((d: { cumulativeOrders: number }) => d.cumulativeOrders)).toEqual([2, 2, 6]);
  });

  it("그룹 미소속이면 그룹 로더를 부르지 않고 자기 회차만 본다", async () => {
    await callGet();
    expect(getMobileCampaignGroupSales).not.toHaveBeenCalled();
    expect(getMobileCampaignSales).toHaveBeenCalledWith("camp-1", expect.any(Date), {
      includeIntraday: true,
    });
    expect(campaignFindMany).not.toHaveBeenCalled();
  });

  // 빈 상태가 "수집된 게시물은 있는데 타임라인엔 없다"는 체감 모순을 설명하려면, 화면이
  // **왜 비었는지**를 데이터로 받아야 한다(오너 지적 2026-08-02).
  describe("context — 빈 상태의 사유", () => {
    it("이벤트가 0건이면 미검토 후보 수와 발주 연결 여부를 담는다", async () => {
      findUnique.mockResolvedValue({
        id: "camp-1",
        sellerId: "seller-1",
        groupId: null,
        orderCampaignId: null, // 발주 미연결 → 주문축이 빈다
        startDate: new Date("2026-07-01T00:00:00+09:00"),
        endDate: new Date("2026-07-03T00:00:00+09:00"),
      });
      storyCount.mockResolvedValue(2);
      loadSuggestedPosts.mockResolvedValue({
        suggestions: [{ permalink: "p1" }, { permalink: "p2" }, { permalink: "p3" }],
        lastCollectedAt: null,
        sharedCampaignIds: ["camp-1"],
        reviewClosed: false,
      });

      const res = await callGet();
      const body = await res.json();
      expect(body.context).toEqual({
        orderLinked: false,
        unreviewedStories: 2,
        unreviewedPostCandidates: 3,
        reviewClosed: false,
      });
    });

    it("미검토 스토리는 창 안 UNREVIEWED 만 센다(캠페인 분류분은 이미 이벤트다)", async () => {
      findUnique.mockResolvedValue({
        id: "camp-1", sellerId: "seller-1", groupId: null, orderCampaignId: null,
        startDate: new Date("2026-07-01T00:00:00+09:00"),
        endDate: new Date("2026-07-03T00:00:00+09:00"),
      });
      await callGet();
      const arg = storyCount.mock.calls[0][0];
      expect(arg.where).toMatchObject({ sellerId: "seller-1", classification: "UNREVIEWED" });
      expect(arg.where.takenAt).toBeDefined();
    });

    it("검토 기간이 끝났으면 그 사실을 그대로 내린다(후보가 더 늘지 않는 상태)", async () => {
      findUnique.mockResolvedValue({
        id: "camp-1", sellerId: "seller-1", groupId: null, orderCampaignId: null,
        startDate: new Date("2026-07-01T00:00:00+09:00"),
        endDate: new Date("2026-07-03T00:00:00+09:00"),
      });
      loadSuggestedPosts.mockResolvedValue({
        suggestions: [],
        lastCollectedAt: null,
        sharedCampaignIds: ["camp-1"],
        reviewClosed: true,
      });
      const res = await callGet();
      const body = await res.json();
      expect(body.context.reviewClosed).toBe(true);
      expect(body.context.unreviewedPostCandidates).toBe(0);
    });

    it("이벤트가 있으면 후보 조회를 아예 하지 않는다(정상 경로에 쿼리를 얹지 않는다)", async () => {
      assetFindMany.mockResolvedValue([
        {
          id: "a1", mediaType: "reel", postedAt: new Date("2026-07-02T10:00:00+09:00"),
          thumbnailUrl: null, externalUrl: "https://x", likeCount: 1, commentCount: 1,
          likesHidden: false,
        },
      ]);
      const res = await callGet();
      const body = await res.json();
      expect(body.context).toEqual({
        orderLinked: true,
        unreviewedStories: 0,
        unreviewedPostCandidates: 0,
        reviewClosed: false,
      });
      expect(loadSuggestedPosts).not.toHaveBeenCalled();
      expect(storyCount).not.toHaveBeenCalled();
    });
  });

  describe("그룹 캠페인 통합 스코프", () => {
    beforeEach(() => {
      findUnique.mockResolvedValue({
        id: "camp-1",
        sellerId: "seller-1",
        groupId: "grp-1",
        startDate: new Date("2026-07-02T00:00:00+09:00"),
        endDate: new Date("2026-07-02T00:00:00+09:00"),
      });
      // 형제 회차가 앞뒤로 더 길다 — 창은 멤버 포락선이어야 한다.
      campaignFindMany.mockResolvedValue([
        {
          id: "camp-1",
          startDate: new Date("2026-07-02T00:00:00+09:00"),
          endDate: new Date("2026-07-02T00:00:00+09:00"),
        },
        {
          id: "camp-2",
          startDate: new Date("2026-07-01T00:00:00+09:00"),
          endDate: new Date("2026-07-03T00:00:00+09:00"),
        },
      ]);
    });

    it("주문은 그룹 통합 로더에서 읽는다(회차 1건 로더 미사용)", async () => {
      await callGet();
      expect(getMobileCampaignGroupSales).toHaveBeenCalledWith("grp-1", expect.any(Date), {
        includeIntraday: true,
      });
      expect(getMobileCampaignSales).not.toHaveBeenCalled();
    });

    it("그룹의 인트라데이도 통합 로더가 낸 것을 그대로 싣는다", async () => {
      const res = await callGet();
      const body = await res.json();
      expect(body.intraday.points).toEqual([{ startMs: 2, orders: 9, revenue: 90000 }]);
    });

    it("자산·스토리 스코프가 멤버 전체로 넓어진다", async () => {
      await callGet();
      expect(assetFindMany.mock.calls[0][0].where).toMatchObject({
        entityId: { in: ["camp-1", "camp-2"] },
      });
      expect(storyFindMany.mock.calls[0][0].where).toMatchObject({
        OR: [{ salesCampaignId: null }, { salesCampaignId: { in: ["camp-1", "camp-2"] } }],
      });
    });

    it("형제 회차에 분류된 스토리도 같은 묶음의 발행이므로 포함한다", async () => {
      const rows: StoryRow[] = [
        {
          id: "s-sibling", sellerId: "seller-1", classification: "CAMPAIGN",
          salesCampaignId: "camp-2", takenAt: new Date("2026-07-02T11:00:00+09:00"),
          thumbnailUrl: null,
        },
        {
          id: "s-outside", sellerId: "seller-1", classification: "CAMPAIGN",
          salesCampaignId: "camp-9", takenAt: new Date("2026-07-02T12:00:00+09:00"),
          thumbnailUrl: null,
        },
      ];
      storyFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
        applyStoryWhere(rows, args.where),
      );
      const res = await callGet();
      const body = await res.json();
      const day = body.days.find((d: { date: string }) => d.date === "2026-07-02");
      const ids = day.events.map((e: { id: string }) => e.id);
      expect(ids).toContain("story-s-sibling");
      expect(ids).not.toContain("story-s-outside");
    });

    it("창은 멤버 포락선이다 — 자기 회차 기간만 보면 형제 구간이 통째로 잘린다", async () => {
      const res = await callGet();
      const body = await res.json();
      expect(body.days.map((d: { date: string }) => d.date)).toEqual([
        "2026-07-01", "2026-07-02", "2026-07-03",
      ]);
    });

    it("응답 scope로 그룹 통합임을 알린다(회차 하나로 오독 방지)", async () => {
      const res = await callGet();
      const body = await res.json();
      expect(body.scope).toEqual({ kind: "group", campaignCount: 2 });
    });
  });
});
