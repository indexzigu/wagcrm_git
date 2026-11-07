// [셀러분석] 셀러 비교표 로더 — 최대 8명의 비교 원재료를 한 번에 읽는다.
//
// 분석 스냅샷(SellerAiProfile.aiTags)은 셀러당 수백 KB 가 될 수 있다(postsPreview·Gemini 서술).
// 비교표가 쓰는 경로는 category·metrics·profileMeta 와, 위험 신호 판정에 쓰는 게시물 두 필드
// (taken_at·is_gongu)뿐이라 Postgres 에서는 그 경로만 jsonb 연산자로 잘라 받는다.
// 파라미터는 Prisma.sql 태그 템플릿으로만 바인딩한다(문자열 보간 금지).
// sqlite(dev:demo·dev:local 가공 데이터 DB)는 jsonb 연산자가 없어 aiTags 전체를 읽고 같은 투영을 JS 로 한다.

import { Prisma, type PrismaClient } from "@prisma/client";
import { isSqliteDatabaseUrl } from "./prisma-client";
import {
  normalizeComparisonIds,
  type SellerComparisonAnalysis,
  type SellerComparisonSource,
} from "./seller-comparison-rows";

/** 30일 증감 계산에 넉넉한 창 — computeFollowerGrowthRate 는 최근 30일만 본다 */
const FOLLOWER_SNAPSHOT_WINDOW_DAYS = 60;

export type SellerComparisonPrisma = Pick<
  PrismaClient,
  "seller" | "sellerAiProfile" | "salesCampaign" | "sellersHistory" | "$queryRaw"
>;

export interface SellerComparisonData {
  /** 주소 ids 순서를 유지한, 실제로 찾은 셀러 */
  sellers: SellerComparisonSource[];
  /** 형식 오류·상한 초과·DB 미존재로 뺀 수 */
  droppedCount: number;
}

interface AnalysisRow {
  sellerId: string;
  analyzedAt: Date | string | null;
  compositeScore: number | null;
  confidence: string | null;
  category: unknown;
  metrics: unknown;
  profileMeta: unknown;
  postsLite: unknown;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** aiTags 전체 → 비교표가 쓰는 경로만 (sqlite 경로 · Postgres 쿼리와 같은 모양) */
export function projectAiTags(aiTags: unknown): Pick<
  AnalysisRow,
  "category" | "metrics" | "profileMeta" | "postsLite"
> {
  const tags = aiTags && typeof aiTags === "object" ? (aiTags as Record<string, unknown>) : {};
  const posts = Array.isArray(tags.postsPreview) ? tags.postsPreview : null;
  return {
    category: tags.category ?? null,
    metrics: tags.metrics ?? null,
    profileMeta: tags.profileMeta ?? null,
    postsLite: posts
      ? posts
          .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
          .map((p) => ({ taken_at: p.taken_at ?? null, is_gongu: p.is_gongu === true }))
      : null,
  };
}

async function loadAnalysisRows(prisma: SellerComparisonPrisma, ids: string[]): Promise<AnalysisRow[]> {
  if (ids.length === 0) return [];

  if (isSqliteDatabaseUrl()) {
    const rows = await prisma.sellerAiProfile.findMany({
      where: { sellerId: { in: ids } },
      select: { sellerId: true, analyzedAt: true, compositeScore: true, confidence: true, aiTags: true },
    });
    return rows.map((row) => ({
      sellerId: row.sellerId,
      analyzedAt: row.analyzedAt,
      compositeScore: row.compositeScore,
      confidence: row.confidence,
      ...projectAiTags(row.aiTags),
    }));
  }

  const rows = await prisma.$queryRaw<AnalysisRow[]>(Prisma.sql`
    SELECT
      "sellerId",
      "analyzedAt",
      "compositeScore",
      "confidence",
      "aiTags"->'category' AS "category",
      "aiTags"->'metrics' AS "metrics",
      "aiTags"->'profileMeta' AS "profileMeta",
      CASE
        WHEN jsonb_typeof("aiTags"->'postsPreview') = 'array' THEN (
          SELECT jsonb_agg(jsonb_build_object('taken_at', p->'taken_at', 'is_gongu', p->'is_gongu'))
          FROM jsonb_array_elements("aiTags"->'postsPreview') AS p
        )
        ELSE NULL
      END AS "postsLite"
    FROM "SellerAiProfile"
    WHERE "sellerId" IN (${Prisma.join(ids)})
  `);
  return rows;
}

/**
 * 비교 대상 원재료를 읽는다. 결과는 직렬화 가능(Date → ISO, Decimal → number)해서
 * "use cache" 경계를 그대로 넘는다. ids 정규화(중복·형식·8명 상한)는 여기서도 다시 한다 —
 * 호출자가 원시 주소 값을 넘겨도 상한을 넘는 조회가 생기지 않게.
 */
export async function loadSellerComparison(
  prisma: SellerComparisonPrisma,
  rawIds: string | readonly string[] | null | undefined,
  now: Date = new Date(),
): Promise<SellerComparisonData> {
  const { ids, droppedCount } = normalizeComparisonIds(rawIds);
  if (ids.length === 0) return { sellers: [], droppedCount };

  const since = new Date(now.getTime() - FOLLOWER_SNAPSHOT_WINDOW_DAYS * 86_400_000);

  const [sellers, analysisRows, campaigns, snapshots] = await Promise.all([
    prisma.seller.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, alias: true, currentFollowers: true, fitLevel: true },
    }),
    loadAnalysisRows(prisma, ids),
    prisma.salesCampaign.findMany({
      where: { sellerId: { in: ids } },
      select: {
        sellerId: true,
        actualSales: true,
        sellerFeeBasisOverride: true,
        sellerMarginRate: true,
        campaignDeals: { select: { sellerMarginRate: true } },
        groupId: true,
        status: true,
        startDate: true,
      },
    }),
    prisma.sellersHistory.findMany({
      where: { sellerId: { in: ids }, snapshotDate: { gte: since } },
      select: { sellerId: true, snapshotDate: true, followersCount: true },
      orderBy: { snapshotDate: "asc" },
    }),
  ]);

  const analysisBySeller = new Map(analysisRows.map((row) => [row.sellerId, row]));
  const sellerById = new Map(sellers.map((s) => [s.id, s]));

  const found: SellerComparisonSource[] = [];
  for (const id of ids) {
    const seller = sellerById.get(id);
    if (!seller) continue;
    const a = analysisBySeller.get(id);
    const analysis: SellerComparisonAnalysis | null = a
      ? {
          analyzedAt: toIso(a.analyzedAt),
          compositeScore: toNumber(a.compositeScore),
          confidence: a.confidence ?? null,
          category: a.category ?? null,
          metrics: a.metrics ?? null,
          profileMeta: a.profileMeta ?? null,
          postsLite: a.postsLite ?? null,
        }
      : null;

    found.push({
      id: seller.id,
      name: seller.name,
      alias: seller.alias,
      currentFollowers: seller.currentFollowers,
      fitLevel: seller.fitLevel,
      analysis,
      campaigns: campaigns
        .filter((c) => c.sellerId === id)
        .map((c) => ({
          actualSales: toNumber(c.actualSales),
          sellerFeeBasisOverride: toNumber(c.sellerFeeBasisOverride),
          sellerMarginRate: toNumber(c.sellerMarginRate),
          campaignDeals: c.campaignDeals.map((d) => ({ sellerMarginRate: toNumber(d.sellerMarginRate) })),
          groupId: c.groupId,
          status: c.status,
          startDate: toIso(c.startDate),
        })),
      followerSnapshots: snapshots
        .filter((s) => s.sellerId === id)
        .map((s) => ({ snapshotDate: toIso(s.snapshotDate) ?? "", followersCount: s.followersCount }))
        .filter((s) => s.snapshotDate !== ""),
    });
  }

  return { sellers: found, droppedCount: droppedCount + (ids.length - found.length) };
}
