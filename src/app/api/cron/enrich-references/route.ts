import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { ASSET_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { isSellerMediaStorageConfigured } from "@/lib/seller-analysis/seller-media-storage";
import {
  buildAutoNote,
  classifyReferenceUrl,
  deriveYoutubeThumbnailUrl,
} from "@/lib/reference-enrich";
import {
  fetchInstagramPostMeta,
  rehostReferenceThumbnail,
} from "@/lib/reference-enrich-proxy";
import {
  syncCampaignPostEngagement,
  type CampaignEngagementSyncResult,
} from "@/lib/collectors/campaign-engagement-collector";
import { declareTotalFailure } from "@/lib/cron-outcome";
import { verifyCronAuth } from "@/lib/cron-auth";

// 레퍼런스 링크 메타데이터 보강 sweep (R3) — 일일 크론(30 22 * * * UTC = KST 07:30).
// R1(딜 직접 등록)·R2a(인박스 승격)로 생긴 EXTERNAL_LINK Asset에 썸네일(영구 재호스팅)·
// 캡션을 채운다. 상태 추적 필드 없이 `thumbnailUrl IS NULL AND createdAt > now()-14일`로
// 재시도가 자연 바운딩된다(실패 건은 최대 14회 재시도 후 자연 탈락 — Apify 단가 ~$0.001/건).
//
// 스케줄 구동은 GitHub Actions(.github/workflows/cron-driver.yml)로 이관됐다 — Vercel Hobby
// 크론이 미발화/불안정하기 때문(플랜 제약). 엔드포인트·인증(CRON_SECRET)은 동일하다.
//
// ⚠️ Hobby 함수 실행 상한(~60s)은 maxDuration=300을 60s로 클램프한다. 그래서 사용자 노출
//    지표(캠페인 반응 수집)를 항상 "먼저" 완주시키고, 남는 예산으로 썸네일 스윕을 돌린다
//    (스윕이 중단돼도 다음 주기 재시도로 자연 복구). 앞뒤가 바뀌면 스윕이 예산을 다 먹어
//    지표 수집이 아예 실행되지 못한다.
export const maxDuration = 300;
// Hobby 60s 상한 아래 헤드룸. 지표 수집(앞단계)에 넉넉히 배분하고 스윕은 나머지로 바운딩.
const OVERALL_BUDGET_MS = 55_000;
const ENGAGEMENT_BUDGET_MS = 30_000;

const LOOKBACK_DAYS = 14;
const BATCH_SIZE = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 이 크론의 **실질 실패 선언** — HTTP 200 이어도 시도한 대상이 전부 실패했으면 실패로
 * 기록한다. 선언이 없으면 `withSystemTaskStatus` 가 SUCCESS 로 남긴다(`CronOutcomeBody` 계약).
 *
 * **두 단계를 합쳐 잰다** — 한 단계가 죽어도 다른 단계가 산출을 냈으면 그 실행은 헛돌지
 * 않았다(`collect-instagram` 과 같은 판단). 그래서 반환 경로가 둘(스토리지 미설정 디그레이드
 * 포함)이어도 계산은 여기 한 곳에 둔다 — 한쪽만 고치면 그 경로가 조용히 초록으로 남는다.
 *
 * ⚠️ 1단계의 시도는 `sellersProcessed + failedCount` 가 **아니다** — Tier0 미설정처럼 단계가
 * 통째로 막히면 두 값이 모두 0이라, 2단계가 마침 대상 0인 날 합산 시도까지 0이 되어 반응
 * 지표 수집이 죽은 채 SUCCESS 가 된다. 감시 대상에서 멱등 스킵·데드라인 이월분을 뺀 값으로 잰다.
 * ⚠️ 2단계의 미지원 호스트(`skippedUnsupported`)와 데드라인에 걸려 손도 못 댄 자산은 시도가
 * 아니다 — 시도로 세면 tiktok 링크만 쌓인 날·느린 날이 상시 빨강이 된다.
 */
function declareEnrichOutcome(input: {
  engagement: CampaignEngagementSyncResult;
  enriched: number;
  sweepFailed: number;
}) {
  const { engagement, enriched, sweepFailed } = input;
  const engagementAttempted =
    engagement.sellersMonitored - engagement.sellersSkipped - engagement.sellersDeferred;
  return declareTotalFailure({
    attempted: engagementAttempted + enriched + sweepFailed,
    succeeded: engagement.sellersProcessed + enriched,
    unit: "건",
    what: "레퍼런스 보강(반응 지표·썸네일)",
  });
}

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startMs = Date.now();

  // 1단계: 캠페인 셀러 게시물 반응 지표(좋아요·댓글·숨김·유형·영상) — 항상 "먼저" 완주.
  // 스토리지 무관(Graph Tier0 무료 1콜/셀러)이고 사용자 노출 지표라 Hobby 예산을 우선 배정한다.
  const engagement = await syncCampaignPostEngagement({
    deadlineMs: startMs + ENGAGEMENT_BUDGET_MS,
  });
  if (engagement.deadlineReached) {
    console.warn("[enrich-references] 반응 지표 수집 데드라인 도달 — 잔여 셀러는 다음 주기로 이월");
  }

  if (!isSellerMediaStorageConfigured()) {
    // 재호스팅 불가 상태에서 파싱만 돌리면 낭비 — 썸네일 스윕만 디그레이드(지표는 위에서 이미 수집).
    if (engagement.assetsUpdated > 0) {
      revalidateCrmTags(ASSET_INVALIDATION_TAGS);
    }
    return NextResponse.json({
      scanned: 0,
      enriched: 0,
      skippedUnsupported: 0,
      failedCount: 0,
      skipped: "storage env 미설정 (SUPABASE_SERVICE_ROLE_KEY 필요)",
      engagement,
      // 스윕은 못 돌았지만 1단계는 이미 돌았다 — 그 전량 실패는 여기서도 보여야 한다.
      ...declareEnrichOutcome({ engagement, enriched: 0, sweepFailed: 0 }),
    });
  }

  // 썸네일 스윕은 남는 예산으로만 — 중단돼도 다음 주기 재시도(thumbnailUrl IS NULL로 자연 복구).
  const deadlineMs = startMs + OVERALL_BUDGET_MS;
  const prisma = getPrisma();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const assets = await prisma.asset.findMany({
    where: {
      provider: "EXTERNAL_LINK",
      section: "SNS_CREATIVE",
      thumbnailUrl: null,
      archivedAt: null,
      externalUrl: { not: null },
      createdAt: { gt: since },
    },
    orderBy: { createdAt: "desc" },
    take: BATCH_SIZE,
    select: { id: true, entityId: true, externalUrl: true, notes: true },
  });

  let enriched = 0;
  let skippedUnsupported = 0;
  /**
   * 보강에 실패한 자산 **수**.
   *
   * ⛔ 이 이름을 `failed` 로 되돌리지 말 것 — `failed` 는 크론 응답 계약(`CronOutcomeBody`,
   * `src/lib/system-task-status.ts`)이 **불리언으로 예약**한 키다. 개수가 그 이름을 쓰고 있으면
   * 실패 선언을 얹을 때 둘 중 하나가 소리 없이 사라지고, 개수가 남는 쪽이면 `=== true` 비교에
   * 걸리지 않아 **전량 실패가 영영 초록**이 된다(이 잡이 실제로 그 상태였다).
   */
  let failedCount = 0;
  let instagramTouched = false;

  for (const asset of assets) {
    if (Date.now() >= deadlineMs) break;
    // per-item 격리: Asset은 독립 개체 — 한 건 실패가 다음 건 처리를 막으면 안 된다
    try {
      const url = asset.externalUrl;
      if (!url) {
        // 쿼리(externalUrl not null)상 도달 불가 — TS 내로잉용 방어
        skippedUnsupported++;
        continue;
      }
      const source = classifyReferenceUrl(url);
      if (source === "UNSUPPORTED") {
        skippedUnsupported++; // tiktok/naver 등 — 후속 대상, no-op이라 비용 0
        continue;
      }

      if (source === "YOUTUBE") {
        // 무비용 파생(video id → img.youtube.com) — Apify 0원
        const originThumb = deriveYoutubeThumbnailUrl(url);
        if (!originThumb) {
          skippedUnsupported++; // video id 파생 불가(채널·재생목록 URL 등)
          continue;
        }
        const hosted = await rehostReferenceThumbnail(originThumb, asset.id, asset.entityId);
        if (!hosted) throw new Error("스토리지 미설정으로 재호스팅 불가"); // 상단 가드로 도달 불가
        await prisma.asset.update({
          where: { id: asset.id },
          data: { thumbnailUrl: hosted },
        });
        enriched++;
        continue;
      }

      // INSTAGRAM — Apify 단건 조회. 인스타 건 사이에만 시간차(2.5s+지터 — mediaRehost 패턴)
      if (instagramTouched) await sleep(2500 + Math.floor(Math.random() * 2000));
      instagramTouched = true;
      const meta = await fetchInstagramPostMeta(url);
      if (!meta || !meta.thumbnailUrl) {
        throw new Error("Apify 응답에 썸네일 없음");
      }
      const hosted = await rehostReferenceThumbnail(meta.thumbnailUrl, asset.id, asset.entityId);
      if (!hosted) throw new Error("스토리지 미설정으로 재호스팅 불가"); // 상단 가드로 도달 불가
      // notes는 비어있을 때만 자동 메모 — 사용자 메모 덮어쓰기 금지
      const autoNote =
        !asset.notes && meta.caption ? buildAutoNote(meta.caption, meta.likes) : null;
      await prisma.asset.update({
        where: { id: asset.id },
        data: { thumbnailUrl: hosted, ...(autoNote ? { notes: autoNote } : {}) },
      });
      enriched++;
    } catch (e) {
      failedCount++;
      console.error(
        `[enrich-references] asset ${asset.id} (${asset.externalUrl}) 보강 실패:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  // 이벤트 기반 무효화(2026-07-10): 썸네일/캡션/지표를 실제로 채운 스윕만 자산 표면 캐시를 깬다.
  if (enriched > 0 || engagement.assetsUpdated > 0) {
    revalidateCrmTags(ASSET_INVALIDATION_TAGS);
  }

  // 부분 실패 명시(P0) — scanned는 이번 스윕 선택 건수(take 8 캡). engagement는 1단계에서 수집.
  return NextResponse.json({
    scanned: assets.length,
    enriched,
    skippedUnsupported,
    failedCount,
    engagement,
    ...declareEnrichOutcome({ engagement, enriched, sweepFailed: failedCount }),
  });
}

export const GET = withSystemTaskStatus("enrich-references", handler);
