import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSimilarSellers, type SimilarSellersPrisma } from "../seller-similar-sellers";

// [셀러분석] 비슷한 셀러 로더. Prisma 는 가짜 객체다(DB 접속 없음) — 픽스처는 전부 가상 값.

const NOW = new Date("2026-06-15T00:00:00Z");

function analysisRow(sellerId: string, tags: string[], category = "리빙") {
  return {
    sellerId,
    analyzedAt: new Date("2026-06-01T00:00:00Z"),
    compositeScore: 60,
    confidence: "medium",
    category,
    tags,
    sub_categories: [],
    legacyArray: null,
    engagement: { er: 0.031 },
    cadence: { medianIntervalDays: 2 },
    profileMeta: { followerCount: 10_000, followingCount: 300 },
  };
}

function fakePrisma(rows: ReturnType<typeof analysisRow>[]) {
  const queryRaw = vi.fn(async () => rows);
  const sellerFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, name: `가상 셀러 ${id}`, alias: id === "s1" ? "가상 별칭" : null, currentFollowers: 12_000 })),
  );
  const campaignFindMany = vi.fn(async () => [
    { sellerId: "s1", groupId: "g1", status: "CLOSED", startDate: new Date("2026-04-10T00:00:00Z") },
    { sellerId: "s1", groupId: "g1", status: "CLOSED", startDate: new Date("2026-04-10T00:00:00Z") },
    { sellerId: "s1", groupId: null, status: "PROPOSAL", startDate: new Date("2026-08-01T00:00:00Z") },
  ]);
  const prisma = {
    seller: { findMany: sellerFindMany },
    sellerAiProfile: { findMany: vi.fn() },
    salesCampaign: { findMany: campaignFindMany },
    $queryRaw: queryRaw,
  } as unknown as SimilarSellersPrisma;
  return { prisma, queryRaw, campaignFindMany };
}

describe("loadSimilarSellers", () => {
  const originalUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/synthetic";
  });
  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
  });

  it("aiTags 는 필요한 경로만 raw 쿼리로 읽는다(분석문·프리뷰 전량 미포함, 바인딩 값 없음)", async () => {
    const { prisma, queryRaw } = fakePrisma([analysisRow("t", ["수납"])]);
    await loadSimilarSellers(prisma, "t", NOW);
    const sql = (queryRaw.mock.calls as unknown as unknown[][])[0][0] as { values: unknown[]; strings: string[] };
    const text = sql.strings.join("?");
    expect(sql.values).toEqual([]);
    expect(text).toContain(`'metrics'->'engagement'`);
    expect(text).not.toContain("postsPreview");
    expect(text).not.toMatch(/"aiTags"\s+AS/);
  });

  it("분석 셀러가 8명 미만이면 풀 부족 상태로 끝낸다(캠페인 조회 없음)", async () => {
    const { prisma, campaignFindMany } = fakePrisma([analysisRow("t", ["수납"]), analysisRow("s1", ["수납"])]);
    expect(await loadSimilarSellers(prisma, "t", NOW)).toEqual({ status: "POOL_TOO_SMALL", poolSize: 2 });
    expect(campaignFindMany).not.toHaveBeenCalled();
  });

  it("대상이 미분석이면 TARGET_UNANALYZED", async () => {
    const { prisma } = fakePrisma([analysisRow("s1", ["수납"])]);
    expect((await loadSimilarSellers(prisma, "t", NOW)).status).toBe("TARGET_UNANALYZED");
  });

  it("진행 캠페인은 그룹을 1건으로 센다 · 마지막은 시작일 도래한 실행분만 · 별칭 우선", async () => {
    const rows = [
      analysisRow("t", ["수납", "살림"]),
      analysisRow("s1", ["수납", "살림"]),
      ...Array.from({ length: 7 }, (_, i) => analysisRow(`f${i}`, [`가상${i}`], "스포츠")),
    ];
    const { prisma } = fakePrisma(rows);
    const data = await loadSimilarSellers(prisma, "t", NOW);
    if (data.status !== "OK") throw new Error("expected OK");
    expect(data.poolSize).toBe(9);
    expect(data.items.map((i) => i.id)).toEqual(["s1"]);
    const [item] = data.items;
    expect(item.displayName).toBe("가상 별칭");
    expect(item.effectiveCampaigns).toBe(2);
    expect(item.lastRunStartAt).toBe("2026-04-10T00:00:00.000Z");
    expect(item.engagementRate).toBe(0.031);
    expect(item.followers).toBe(12_000);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});
