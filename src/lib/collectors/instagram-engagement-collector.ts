// 감시 셀러 ER 적립 (§11-3) — collect-instagram 크론의 2단계.
// 크론은 매일 발화하고, 실제 수집 주기는 셀러별 cutoff(collect-cycle, 기본 7일)가 정한다 —
// 이월·실패분이 다음 날 이어받으므로 "월요일에 못 잡힌 셀러가 일주일 밀리는" 구멍이 없다.
// 1단계(collectInstagramFollowers)는 프로필 겉면(팔로워 수)만 긁는 경량 경로라 ER을 만들 수 없다.
// 이 단계는 Tier0 Graph business_discovery 1콜(무료)로 게시물 like/comment 카운트를 받아
// computeSellerMetrics로 ER을 계산하고 SellersHistory에 파생 스칼라만 적립한다.
// - Tier0 전용: 크론에서 유료 폴백(Apify/RapidAPI)으로 내려가지 않는다 — 실패는 기록하고 다음 주기로.
// - Gemini/재호스팅 없음: analyze 라우트의 무거운 경로와 분리된 지표-only 수집.
import { getPrisma } from "@/lib/prisma";
import { getCollectCutoff } from "@/lib/collect-cycle";
import { collectModeUnsetReason, resolveCollectMode } from "@/lib/collect-mode";
import { isGraphConfigured, scrapeTier0 } from "@/lib/seller-analysis/graphScraper";
import { applyDbInstagramToken } from "@/lib/instagram-token";
import { computeSellerMetrics } from "@/lib/seller-analysis/metrics";
import { recordSellerMetricsSnapshot } from "@/lib/seller-history";

export interface EngagementCollectionResult {
  collectedCount: number;
  skippedCount: number;
  failedCount: number;
  deadlineReached: boolean;
  errors: Array<{ sellerId: string; snsHandle: string; error: string }>;
}

export async function collectInstagramEngagement(options?: {
  /** 이 시각(epoch ms)을 넘기면 남은 셀러를 다음 회차(=다음 날)로 미룬다 (Vercel maxDuration 보호) */
  deadlineMs?: number;
  /** 셀러 간 간격 (Graph rate limit 완충, 기본 1500ms) */
  spacingMs?: number;
}): Promise<EngagementCollectionResult> {
  const prisma = getPrisma();
  const result: EngagementCollectionResult = {
    collectedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    deadlineReached: false,
    errors: [],
  };

  // mock 모드(로컬/테스트)나 Tier0 미설정이면 조용히 성공하지 않고 사유를 남긴다 (P0 No Silent Failure)
  const mode = resolveCollectMode("INSTAGRAM");
  if (!mode) {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `skipped: ${collectModeUnsetReason("INSTAGRAM")}` });
    return result;
  }
  if (mode === "mock") {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: "skipped: INSTAGRAM_COLLECT_MODE=mock" });
    return result;
  }
  // 게이트보다 먼저 DB 토큰을 프로세스 env 에 얹는다 — 사유는 `campaign-posts-refresh.ts`
  // 의 같은 호출부 주석(2026-08-26 실사고). 여기는 `collect-instagram` 라우트가 이미 한 번
  // 부르지만, 호출자에 의존하면 진입점이 늘 때 또 갈린다 — 게이트 옆에 둔다(멱등).
  await applyDbInstagramToken();
  if (!isGraphConfigured()) {
    result.errors.push({
      sellerId: "SYSTEM",
      snsHandle: "",
      error: "skipped: INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_BUSINESS_ACCOUNT_ID 미설정 (Tier0 전용 단계)",
    });
    return result;
  }

  const sellers = await prisma.seller.findMany({
    where: { snsType: "INSTAGRAM", isMonitored: true },
    select: { id: true, snsHandle: true },
  });
  if (sellers.length === 0) return result;

  // 1단계와 동일한 주기 규약 (기본 7일, SSOT=collect-cycle): 주기 내 ER 적립분이 있으면
  // 건너뛴다 (재시도 멱등). 크론이 매일 발화하므로 이 cutoff가 실제 수집 주기를 결정한다.
  const cutoffDate = getCollectCutoff();

  const spacingMs = options?.spacingMs ?? 1500;

  for (const seller of sellers) {
    if (options?.deadlineMs && Date.now() >= options.deadlineMs) {
      // 남은 셀러는 다음 날 크론이 cutoff 검사로 자연히 이어받는다(크론이 매일이므로 최대 1일 지연)
      result.deadlineReached = true;
      break;
    }

    try {
      const recent = await prisma.sellersHistory.findFirst({
        where: { sellerId: seller.id, er: { not: null }, snapshotDate: { gt: cutoffDate } },
        select: { id: true },
      });
      if (recent) {
        result.skippedCount++;
        continue;
      }

      const data = await scrapeTier0(seller.snsHandle);
      const metrics = computeSellerMetrics(data);
      const followerCount = Number(data.profile?.follower_count) || 0;
      if (followerCount <= 0) {
        // 0/실패 센티널은 적립하지 않는다 (analyze 라우트와 동일 원칙)
        throw new Error("Tier0 응답에 유효한 팔로워 수 없음");
      }

      // 이 스냅샷이 셀러 프로필 전체(팔로워·게시물수·bio·프로필사진·외부링크)를 갱신한다 —
      // 같은 BD 응답으로 1단계(collectInstagramFollowers)의 프로필 조회를 대체하기 위함.
      // recordSellerMetricsSnapshot이 프로필사진 미러링·Seller 행 갱신을 이미 처리하므로,
      // 여기서 profilePicUrl·profileExternalUrls만 넘기면 1단계와 무손실 등가가 된다.
      // - profileExternalUrls: 이 지점 도달=scrapeTier0(BD) 성공이므로 항상 동기화한다. 링크가
      //   없으면 빈 배열로 "지운다"(1단계 스크래퍼가 `external_url ? [url] : []`로 매주 지우던
      //   시맨틱과 등가). BD 유무로 undefined 처리하면 제거된 링크가 무기한 남으므로 안 됨.
      // - profilePicUrl: BD가 사진을 안 주면(null) undefined로 통과 → 미러링 스킵·기존값 보존
      //   (1단계도 스크래퍼 사진 없으면 미러링 스킵으로 동일하게 보존).
      const website = typeof data.profile?.website === "string" ? data.profile.website : "";
      await recordSellerMetricsSnapshot(
        seller.id,
        followerCount,
        "GRAPH_ER",
        {
          postsCount: Number(data.profile?.media_count) || undefined,
          profileBio: typeof data.profile?.bio === "string" ? data.profile.bio : undefined,
          profilePicUrl: typeof data.profile?.profilePicUrl === "string" ? data.profile.profilePicUrl : undefined,
          profileExternalUrls: [website].filter(Boolean),
        },
        {
          er: metrics.engagement.er,
          avgLikes: metrics.engagement.avgLikes,
          avgComments: metrics.engagement.avgComments,
        }
      );
      result.collectedCount++;
    } catch (err) {
      result.failedCount++;
      result.errors.push({
        sellerId: seller.id,
        snsHandle: seller.snsHandle,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }

    if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
  }

  return result;
}
