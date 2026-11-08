// [셀러분석] 비슷한 셀러 로더 — 셀러 리포트 하단 섹션(§2-3·§2-4). 내부 전용: 포털·공유 카드에 쓰지 말 것.
//
// 후보 풀 = AI 분석본이 있는 셀러 전원(오너 결정 2026-11-08 — 미분석 셀러 일괄 분석은 별도 결정).
// aiTags 는 유사도·브랜드 계정 판정에 쓰는 경로(category·tags·sub_categories·구형 배열·
// metrics.engagement·metrics.cadence·profileMeta)만 읽는다 — 분석문·프리뷰 전량을 풀 크기만큼 읽지 않는다.
// 진행 캠페인 수는 countEffectiveCampaigns(그룹=1건)로 센다 — 목록 「누적 캠페인」·비교표와 같은 수.

import type { PrismaClient } from "@prisma/client";
import { loadAiTagsPaths } from "./seller-ai-tags-paths";
import { countEffectiveCampaigns } from "./campaign-group-count";
import { tallySellerRuns } from "./seller-dormancy";
import { RUN_STATUSES } from "./recampaign-timing";
import { sellerDisplayName } from "./seller-display-name";
import { normalizeMetrics } from "./seller-analysis/scores";
import { findSimilarSellers, type SimilarityProfile } from "./seller-analysis/similarity";

const SIMILAR_PATHS = [
  "category",
  "tags",
  "sub_categories",
  "legacyArray",
  "engagement",
  "cadence",
  "profileMeta",
] as const;

export type SimilarSellersPrisma = Pick<PrismaClient, "seller" | "sellerAiProfile" | "salesCampaign" | "$queryRaw">;

export interface SimilarSellerItem {
  id: string;
  displayName: string;
  score: number;
  primaryCategory: string | null;
  followers: number | null;
  /** 참여율(분석 시점) */
  engagementRate: number | null;
  sharedTags: string[];
  reasons: string[];
  /** 진행 캠페인(그룹=1건, 전 상태) */
  effectiveCampaigns: number;
  /** 마지막 진행 시작일(ISO) — 진행 이력이 없으면 null */
  lastRunStartAt: string | null;
}

export type SimilarSellersData =
  | { status: "TARGET_UNANALYZED"; poolSize: number }
  | { status: "POOL_TOO_SMALL"; poolSize: number }
  | { status: "OK"; poolSize: number; items: SimilarSellerItem[] };

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 결과는 직렬화 가능(Date → ISO)해서 "use cache" 경계를 그대로 넘는다. */
export async function loadSimilarSellers(
  prisma: SimilarSellersPrisma,
  sellerId: string,
  now: Date = new Date(),
): Promise<SimilarSellersData> {
  const rows = await loadAiTagsPaths(prisma, null, SIMILAR_PATHS);
  if (!rows.some((row) => row.sellerId === sellerId)) {
    return { status: "TARGET_UNANALYZED", poolSize: rows.length };
  }

  const sellers = await prisma.seller.findMany({
    where: { id: { in: rows.map((row) => row.sellerId) } },
    select: { id: true, name: true, alias: true, currentFollowers: true },
  });
  const sellerById = new Map(sellers.map((s) => [s.id, s]));

  const pool: SimilarityProfile[] = [];
  for (const row of rows) {
    const seller = sellerById.get(row.sellerId);
    if (!seller) continue;
    const profileMeta = asObject(row.profileMeta);
    const metaFollowers = typeof profileMeta?.followerCount === "number" ? profileMeta.followerCount : null;
    pool.push({
      id: row.sellerId,
      aiTags: row.legacyArray ?? {
        category: row.category,
        tags: row.tags,
        sub_categories: row.sub_categories,
      },
      // 현재 팔로워(목록·헤더와 같은 수)를 우선하고, 수집 전이면 분석 시점 값으로 폴백한다.
      followers: seller.currentFollowers > 0 ? seller.currentFollowers : metaFollowers,
      metrics: { engagement: row.engagement, cadence: row.cadence },
      profileMeta: row.profileMeta,
    });
  }

  const verdict = findSimilarSellers(sellerId, pool, now);
  if (verdict.status !== "OK") return verdict;

  const matchIds = verdict.matches.map((m) => m.id);
  const campaigns =
    matchIds.length === 0
      ? []
      : await prisma.salesCampaign.findMany({
          where: { sellerId: { in: matchIds } },
          select: { sellerId: true, groupId: true, status: true, startDate: true },
        });

  const items: SimilarSellerItem[] = verdict.matches.map((match) => {
    const seller = sellerById.get(match.id)!;
    const profile = pool.find((p) => p.id === match.id)!;
    const own = campaigns.filter((c) => c.sellerId === match.id);
    // 「마지막」은 목록 「마지막 진행」·비교표와 같은 모수: 실행된 상태 ∩ 시작일 도래분, 그룹은 1회.
    const runRows = own
      .filter((c) => RUN_STATUSES.has(c.status) && c.startDate !== null)
      .map((c) => ({ sellerId: match.id, groupId: c.groupId, rowCount: 1, lastStartAt: c.startDate }));
    const run = tallySellerRuns(runRows, now).get(match.id);
    const lastRunStartAt = run?.lastRunStartAt ?? null;
    return {
      id: match.id,
      displayName: sellerDisplayName(seller),
      score: match.score,
      primaryCategory: match.primaryCategory,
      followers: profile.followers,
      engagementRate: normalizeMetrics(profile.metrics).engagement.er,
      sharedTags: match.sharedTags,
      reasons: match.reasons,
      effectiveCampaigns: countEffectiveCampaigns(own),
      lastRunStartAt,
    };
  });

  return { status: "OK", poolSize: verdict.poolSize, items };
}
