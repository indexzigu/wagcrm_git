// 캠페인 셀러 게시물 반응 지표 수집 — enrich-references 크론의 2단계(일일).
// 활성 창(리드 7일~트레일 3일) 캠페인의 셀러별로 무료 Graph Tier0(business_discovery) 1콜을 받아
// 게시물 like/comment 카운트·좋아요 숨김을 캠페인 Asset 구조화 필드에 적재한다.
// - Tier0 전용: 유료 폴백(Apify/RapidAPI) 금지 — 실패는 기록하고 다음 주기로(오너 외부 API 최소화 원칙).
//   (계약 테스트 instagram-scrape-callers가 이 모듈의 유료 경로 import를 차단한다.)
// - 임의 숫자 금지: 좋아요 숨김(BD like_count 생략)은 likesHidden=true·likeCount=null로 저장.
// - instagram-engagement-collector(주간 ER 적립)와 같은 Tier0 게이트웨이(scrapeTier0)를 공유한다
//   — 호출 시점이 달라(월요일 03시 vs 매일 22:30 UTC) 런 내 중복 호출은 없다.
import { getPrisma } from "@/lib/prisma";
import { collectModeUnsetReason, resolveCollectMode } from "@/lib/collect-mode";
import { isGraphConfigured, scrapeTier0 } from "@/lib/seller-analysis/graphScraper";
import { applyDbInstagramToken } from "@/lib/instagram-token";
import {
  matchAssetEngagement,
  type EngagementAssetInput,
} from "@/lib/campaign-post-engagement";

const LEAD_DAYS = 7; // 캠페인 시작 전 티저 게시물 창(campaign-suggested-posts와 동일)
const TRAIL_DAYS = 3; // 종료 후 최종 수치 확정 창
const DAY_MS = 24 * 60 * 60 * 1000;
/** 셀러 단위 신선도 게이트 — 이 시간 내 전 자산이 동기화됐으면 셀러를 건너뛴다(일일 크론 재실행 멱등). */
const DEFAULT_STALE_MS = 20 * 60 * 60 * 1000;

export interface CampaignEngagementSyncResult {
  /**
   * 이번 실행이 손대야 했던 셀러 수(활성 창 캠페인의 자산 보유 셀러) — **설정 게이트보다
   * 먼저** 채운다.
   *
   * 🪤 이게 없으면 "Tier0 미설정으로 단계가 아예 못 돌았다"와 "활성 캠페인이 없는 날"이
   * 카운터상 똑같아진다(둘 다 전부 0). 크론이 두 단계를 합쳐 전량 실패를 선언하는데,
   * 2단계(썸네일 스윕)가 마침 대상 0이면 합산 시도도 0이 되어 **반응 지표 수집이 죽은 채
   * SUCCESS** 가 된다.
   */
  sellersMonitored: number;
  sellersProcessed: number;
  sellersSkipped: number;
  /**
   * 실행 예산(데드라인)이 끝나 **손도 못 댄** 셀러 수 — 다음 회차가 이어받는다.
   *
   * ⚠️ 시도가 아니다. 시도로 세면 느린 날이 전량 실패로 오인돼 상시 빨강이 된다.
   */
  sellersDeferred: number;
  assetsUpdated: number;
  failedCount: number;
  deadlineReached: boolean;
  errors: Array<{ sellerId: string; snsHandle: string; error: string }>;
}

export async function syncCampaignPostEngagement(options?: {
  /** 이 시각(epoch ms)을 넘기면 남은 셀러를 다음 주기로 미룬다 (Vercel maxDuration 보호) */
  deadlineMs?: number;
  /** 셀러 간 간격 (Graph rate limit 완충, 기본 1500ms — engagement collector와 동일) */
  spacingMs?: number;
  staleMs?: number;
}): Promise<CampaignEngagementSyncResult> {
  const prisma = getPrisma();
  const result: CampaignEngagementSyncResult = {
    sellersMonitored: 0,
    sellersProcessed: 0,
    sellersSkipped: 0,
    sellersDeferred: 0,
    assetsUpdated: 0,
    failedCount: 0,
    deadlineReached: false,
    errors: [],
  };

  const now = Date.now();
  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      startDate: { lte: new Date(now + LEAD_DAYS * DAY_MS) },
      endDate: { gte: new Date(now - TRAIL_DAYS * DAY_MS) },
      seller: { snsType: "INSTAGRAM" },
    },
    select: {
      id: true,
      seller: { select: { id: true, snsHandle: true } },
    },
  });
  if (campaigns.length === 0) return result;

  const assets = await prisma.asset.findMany({
    where: {
      entityType: "CAMPAIGN",
      entityId: { in: campaigns.map((c) => c.id) },
      provider: "EXTERNAL_LINK",
      archivedAt: null,
      externalUrl: { not: null },
    },
    select: { id: true, entityId: true, externalUrl: true, engagementSyncedAt: true },
  });
  if (assets.length === 0) return result;

  // 셀러 → 자산 묶음 (한 셀러의 여러 캠페인/자산을 Tier0 1콜로 처리)
  const sellerByCampaign = new Map(campaigns.map((c) => [c.id, c.seller]));
  const bySeller = new Map<
    string,
    { snsHandle: string; assets: (EngagementAssetInput & { engagementSyncedAt: Date | null })[] }
  >();
  for (const a of assets) {
    const seller = sellerByCampaign.get(a.entityId);
    if (!seller) continue;
    const bucket = bySeller.get(seller.id) ?? { snsHandle: seller.snsHandle, assets: [] };
    bucket.assets.push({ id: a.id, externalUrl: a.externalUrl, engagementSyncedAt: a.engagementSyncedAt });
    bySeller.set(seller.id, bucket);
  }

  // ⚠️ 대상 집계를 **설정 게이트보다 먼저** 한다 — 게이트로 조기 반환하는 날에도 "손대야
  // 했던 셀러가 있었다"는 사실이 남아야 크론이 그 실패를 볼 수 있다. 게이트가 아끼려는 것은
  // Graph 호출이지 위 DB 조회 2건이 아니다(둘 다 인덱스 조회, 외부 비용 0).
  result.sellersMonitored = bySeller.size;
  if (bySeller.size === 0) return result;

  // instagram-engagement-collector와 동일 게이트 — mock(로컬/테스트)·Tier0 미설정은 사유를 남기고 중단
  const mode = resolveCollectMode("INSTAGRAM");
  if (!mode) {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `skipped: ${collectModeUnsetReason("INSTAGRAM")}` });
    return result;
  }
  // ⚠️ mock 은 **돌지 않기로 명시 선택한 것**이라 시도가 아니다 — 대상을 전부 스킵으로 세어
  // 크론의 전량 실패 판정에서 뺀다. 아래 Tier0 미설정 게이트와 반대다: 저쪽은 "돌아야 하는데
  // 못 돈 것"이라 시도로 남겨야 한다. 같이 취급하면 로컬 QA 마다 ERROR 가 남는다.
  // 🪤 이 설명을 분기 **안**에 두지 말 것 — `mock-collect-write-guard.contract.test.ts` 가 이
  //    분기의 조건부터 반환까지를 200자 창으로 훑어 면제 성립을 확인한다. 창을 넘기면 면제가
  //    깨지고, 조건·반환 문구를 주석에 그대로 인용하면 **가짜 매치**가 생겨 진짜 게이트를
  //    지워도 계약이 초록이 된다(스캐너 공허화).
  if (mode === "mock") {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: "skipped: INSTAGRAM_COLLECT_MODE=mock" });
    result.sellersSkipped = bySeller.size;
    return result;
  }
  // 게이트보다 먼저 DB 토큰을 프로세스 env 에 얹는다 — 사유는 `campaign-posts-refresh.ts`
  // 의 같은 호출부 주석(2026-08-26 실사고). ⚠️ 이 경로의 진입점 `enrich-references` 크론은
  // 토큰 주입을 부르지 않았다 — `collect-campaign-posts` 와 같은 잠복 결함이었다.
  await applyDbInstagramToken();
  if (!isGraphConfigured()) {
    result.errors.push({
      sellerId: "SYSTEM",
      snsHandle: "",
      error: "skipped: INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_BUSINESS_ACCOUNT_ID 미설정 (Tier0 전용 단계)",
    });
    return result;
  }

  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const spacingMs = options?.spacingMs ?? 1500;
  const freshCutoff = now - staleMs;

  const sellerEntries = [...bySeller];
  for (const [index, [sellerId, { snsHandle, assets: sellerAssets }]] of sellerEntries.entries()) {
    if (options?.deadlineMs && Date.now() >= options.deadlineMs) {
      result.deadlineReached = true;
      // 손도 못 댄 셀러는 **시도가 아니다** — 크론의 전량 실패 판정에서 빼야 느린 날이
      // 빨강이 되지 않는다.
      result.sellersDeferred = sellerEntries.length - index;
      break;
    }

    // 전 자산이 신선하면 스킵 — 미매칭 자산(50건 창 밖 등)은 syncedAt이 안 갱신되므로 매일 재시도된다
    if (sellerAssets.every((a) => a.engagementSyncedAt && a.engagementSyncedAt.getTime() > freshCutoff)) {
      result.sellersSkipped++;
      continue;
    }

    try {
      const data = await scrapeTier0(snsHandle);
      const updates = matchAssetEngagement(sellerAssets, data.raw_posts);
      if (updates.length > 0) {
        const syncedAt = new Date();
        await prisma.$transaction(
          updates.map((u) =>
            prisma.asset.update({
              where: { id: u.assetId },
              data: {
                likeCount: u.likeCount,
                commentCount: u.commentCount,
                likesHidden: u.likesHidden,
                // 표현 자산 — 같은 응답에서 동반 갱신(videoUrl은 만료성이라 매일 재서명분으로 교체)
                mediaType: u.mediaType,
                videoUrl: u.videoUrl,
                postedAt: u.postedAt,
                engagementSyncedAt: syncedAt,
              },
            }),
          ),
        );
        result.assetsUpdated += updates.length;
      }
      result.sellersProcessed++;
    } catch (err) {
      // per-seller 격리 — 한 셀러 실패(개인계정 BD 불가 등)가 다른 셀러 수집을 막지 않는다
      result.failedCount++;
      result.errors.push({
        sellerId,
        snsHandle,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }

    if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
  }

  return result;
}
