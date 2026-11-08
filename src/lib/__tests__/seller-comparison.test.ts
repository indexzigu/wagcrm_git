import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSellerComparison, projectAiTags, type SellerComparisonPrisma } from "../seller-comparison";

// [셀러분석] 셀러 비교표 로더. Prisma 는 가짜 객체다(DB 접속 없음) — 픽스처는 전부 가상 값.

const NOW = new Date("2026-06-15T00:00:00Z");

function fakePrisma(existingIds: string[]) {
  const sellerFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in
      .filter((id) => existingIds.includes(id))
      // DB 는 순서를 보장하지 않는다 — 로더가 주소 순서로 다시 세우는지 보려고 뒤집는다.
      .reverse()
      .map((id) => ({ id, name: `가상 셀러 ${id}`, alias: null, currentFollowers: 1000, fitLevel: null })),
  );
  const aiFindMany = vi.fn(async () => [
    {
      sellerId: existingIds[0],
      analyzedAt: new Date("2026-06-01T00:00:00Z"),
      compositeScore: 60,
      confidence: "medium",
      aiTags: {
        category: "리빙",
        metrics: { engagement: { er: 0.02 } },
        profileMeta: { followerCount: 1000 },
        postsPreview: [{ taken_at: "2026-05-01T00:00:00Z", is_gongu: true, thumb: "x", likes: 1 }],
        summary: "긴 서술은 비교표에 오지 않는다",
      },
    },
  ]);
  const queryRaw = vi.fn(async () => [
    {
      sellerId: existingIds[0],
      analyzedAt: new Date("2026-06-01T00:00:00Z"),
      compositeScore: 60,
      confidence: "medium",
      category: "리빙",
      metrics: { engagement: { er: 0.02 } },
      profileMeta: null,
      postsLite: [{ taken_at: "2026-05-01T00:00:00Z", is_gongu: true }],
    },
  ]);
  const campaignFindMany = vi.fn(async () =>
    existingIds.map((sellerId) => ({
      sellerId,
      actualSales: { toString: () => "1500000" },
      sellerFeeBasisOverride: null,
      sellerMarginRate: { toString: () => "0.1" },
      campaignDeals: [{ sellerMarginRate: null }],
      groupId: null,
      status: "CLOSED",
      startDate: new Date("2026-05-20T00:00:00Z"),
    })),
  );
  const historyFindMany = vi.fn(async () => [
    { sellerId: existingIds[0], snapshotDate: new Date("2026-06-01T00:00:00Z"), followersCount: 900 },
  ]);
  const prisma = {
    seller: { findMany: sellerFindMany },
    sellerAiProfile: { findMany: aiFindMany },
    salesCampaign: { findMany: campaignFindMany },
    sellersHistory: { findMany: historyFindMany },
    $queryRaw: queryRaw,
  } as unknown as SellerComparisonPrisma;
  return { prisma, sellerFindMany, aiFindMany, queryRaw };
}

describe("loadSellerComparison", () => {
  const originalUrl = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
  });

  describe("Postgres 경로", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/synthetic";
    });

    it("9개 id 는 8개만 조회하고 1명을 뺀 수로 센다", async () => {
      const ids = Array.from({ length: 9 }, (_, i) => `s${i}`);
      const { prisma, sellerFindMany } = fakePrisma(ids);
      const result = await loadSellerComparison(prisma, ids.join(","), NOW);
      expect(sellerFindMany.mock.calls[0][0].where.id.in).toHaveLength(8);
      expect(result.sellers.map((s) => s.id)).toEqual(ids.slice(0, 8));
      expect(result.droppedCount).toBe(1);
    });

    it("DB 에 없는 id 는 빼고 센다 · 중복은 한 번만 · 주소 순서 유지", async () => {
      const { prisma } = fakePrisma(["a", "c"]);
      const result = await loadSellerComparison(prisma, "a,missing,a,c", NOW);
      expect(result.sellers.map((s) => s.id)).toEqual(["a", "c"]);
      expect(result.droppedCount).toBe(1);
    });

    it("분석 스냅샷은 필요한 경로만 파라미터 바인딩 raw 쿼리로 읽는다(aiTags 전체를 읽지 않는다)", async () => {
      const { prisma, queryRaw, aiFindMany } = fakePrisma(["a", "b"]);
      const result = await loadSellerComparison(prisma, "a,b", NOW);
      expect(aiFindMany).not.toHaveBeenCalled();
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = (queryRaw.mock.calls as unknown as unknown[][])[0][0] as { values: unknown[]; strings: string[] };
      expect(sql.values).toEqual(["a", "b"]);
      expect(sql.strings.join("?")).not.toContain("'a'");
      expect(result.sellers[0].analysis?.postsLite).toEqual([{ taken_at: "2026-05-01T00:00:00Z", is_gongu: true }]);
    });

    it("결과는 직렬화 가능하다(Decimal → number, Date → ISO)", async () => {
      const { prisma } = fakePrisma(["a", "b"]);
      const result = await loadSellerComparison(prisma, "a,b", NOW);
      const first = result.sellers[0];
      expect(first.campaigns[0].actualSales).toBe(1_500_000);
      expect(first.campaigns[0].sellerMarginRate).toBe(0.1);
      expect(first.campaigns[0].startDate).toBe("2026-05-20T00:00:00.000Z");
      expect(first.analysis?.analyzedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(first.followerSnapshots).toEqual([{ snapshotDate: "2026-06-01T00:00:00.000Z", followersCount: 900 }]);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it("유효한 id 가 없으면 DB 를 읽지 않는다", async () => {
      const { prisma, sellerFindMany } = fakePrisma([]);
      expect(await loadSellerComparison(prisma, "", NOW)).toEqual({ sellers: [], droppedCount: 0 });
      expect(sellerFindMany).not.toHaveBeenCalled();
    });
  });

  describe("sqlite 경로(가공 데이터 DB)", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "file:./synthetic.db";
    });

    it("jsonb 연산자 대신 findMany 후 같은 모양으로 투영한다", async () => {
      const { prisma, queryRaw, aiFindMany } = fakePrisma(["a", "b"]);
      const result = await loadSellerComparison(prisma, "a,b", NOW);
      expect(queryRaw).not.toHaveBeenCalled();
      expect(aiFindMany).toHaveBeenCalledTimes(1);
      expect(result.sellers[0].analysis).toMatchObject({
        category: "리빙",
        postsLite: [{ taken_at: "2026-05-01T00:00:00Z", is_gongu: true }],
      });
      expect(JSON.stringify(result)).not.toContain("긴 서술");
    });
  });
});

describe("projectAiTags", () => {
  it("비어 있거나 모양이 틀린 aiTags 는 null 로 채운다", () => {
    expect(projectAiTags(null)).toEqual({ category: null, metrics: null, profileMeta: null, postsLite: null });
    expect(projectAiTags({ postsPreview: "x" }).postsLite).toBeNull();
  });
});
