// [셀러분석] 셀러 비교표 로더 — 최대 8명의 비교 원재료를 한 번에 읽는다.
//
// 분석 스냅샷(SellerAiProfile.aiTags)은 셀러당 수백 KB 가 될 수 있다(postsPreview·Gemini 서술).
// 비교표가 쓰는 경로는 category·metrics·profileMeta 와, 위험 신호 판정에 쓰는 게시물 두 필드
// (taken_at·is_gongu)뿐이라 Postgres 에서는 그 경로만 jsonb 연산자로 잘라 받는다.
// 경로 추출·파라미터 바인딩·sqlite 폴백은 비슷한 셀러와 공용 헬퍼(seller-ai-tags-paths.ts)가 맡는다.

import type { PrismaClient } from "@prisma/client";
import { loadAiTagsPaths, projectAiTagsPaths } from "./seller-ai-tags-paths";
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

const COMPARISON_PATHS = ["category", "metrics", "profileMeta", "postsLite"] as const;

/** aiTags 전체 → 비교표가 쓰는 경로만 (sqlite 경로 · Postgres 쿼리와 같은 모양) */
export function projectAiTags(aiTags: unknown): Pick<
  AnalysisRow,
  "category" | "metrics" | "profileMeta" | "postsLite"
> {
  return projectAiTagsPaths(aiTags, COMPARISON_PATHS);
}

async function loadAnalysisRows(prisma: SellerComparisonPrisma, ids: string[]): Promise<AnalysisRow[]> {
  return loadAiTagsPaths(prisma, ids, COMPARISON_PATHS);
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
