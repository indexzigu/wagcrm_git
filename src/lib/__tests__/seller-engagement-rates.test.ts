import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiTagsPathsPrisma } from "../seller-ai-tags-paths";
import { loadSellerEngagementRates } from "../seller-engagement-rates";

const originalUrl = process.env.DATABASE_URL;
afterEach(() => {
  process.env.DATABASE_URL = originalUrl;
});

function fakePrisma(opts: { raw?: unknown[]; rows?: unknown[] }) {
  const queryRaw = vi.fn().mockResolvedValue(opts.raw ?? []);
  const findMany = vi.fn().mockResolvedValue(opts.rows ?? []);
  const prisma = { $queryRaw: queryRaw, sellerAiProfile: { findMany } } as unknown as AiTagsPathsPrisma;
  return { prisma, queryRaw, findMany };
}

describe("loadSellerEngagementRates", () => {
  it("Postgres: jsonb 경로 조회 결과를 숫자만 맵으로 (문자열 숫자 허용, 빈 값·비숫자는 미분석)", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/synthetic";
    const { prisma, queryRaw, findMany } = fakePrisma({
      raw: [
        { sellerId: "a", engagementRate: 0.031 },
        { sellerId: "b", engagementRate: "0.02" },
        { sellerId: "c", engagementRate: null },
        { sellerId: "d", engagementRate: "abc" },
      ],
    });
    await expect(loadSellerEngagementRates(prisma)).resolves.toEqual({ a: 0.031, b: 0.02 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("sqlite: aiTags 전체를 읽어 같은 경로로 투영", async () => {
    process.env.DATABASE_URL = "file:./synthetic.db";
    const { prisma, queryRaw } = fakePrisma({
      rows: [
        { sellerId: "a", aiTags: { metrics: { engagement: { er: 0.05 } } } },
        { sellerId: "b", aiTags: ["legacy", "tags"] },
        { sellerId: "c", aiTags: { metrics: {} } },
      ],
    });
    await expect(loadSellerEngagementRates(prisma)).resolves.toEqual({ a: 0.05 });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
