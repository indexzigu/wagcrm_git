// 홍보 게시물 **후보**의 조회 배선 SSOT — `suggested-posts` GET 과 타임라인 GET 이 공유한다.
//
// 후보 판정 규칙 자체는 여전히 순수 함수 `suggestCampaignPosts` 하나다(이 모듈은 그 함수에
// 넣을 입력을 모으는 일만 한다). 분리한 이유: 타임라인의 빈 상태가 "수집된 게시물이 있는데
// 타임라인은 없다고 한다"는 체감 모순을 풀려면 **자료관리와 정확히 같은 후보 수**를 말해야
// 하는데, 라우트에 인라인으로 두면 두 화면의 숫자가 조용히 갈라진다(같은 종류의 드리프트가
// 이 레포에서 실제로 반복됐다 — codebase-map 의 `loadDealClaimContext` 항목 참조).
import type { PrismaClient } from "@prisma/client";

import { suggestCampaignPosts, type SuggestablePost, type SuggestedPost } from "./campaign-suggested-posts";
import { extractPostsCollectedAt } from "./campaign-posts-refresh";
import { resolveCampaignContentScope } from "./campaign-group-scope";
import { isContentReviewOpen } from "./campaign-review-window";

// is_gongu 필터 해제로 후보 범위가 "기간 내 셀러 전체 피드"로 넓어졌다(오너 2026-07-13). 소스인
// postsPreview 자체가 최근 30개로 제한되므로, 창 안 후보를 잘리지 않게 전량 노출한다.
export const MAX_SUGGESTIONS = 30;

/** SellerAiProfile.aiTags(Json)에서 postsPreview 배열을 방어적으로 꺼낸다(형태 불일치 시 []). */
export function extractPostsPreview(aiTags: unknown): SuggestablePost[] {
  if (!aiTags || typeof aiTags !== "object") return [];
  const preview = (aiTags as Record<string, unknown>).postsPreview;
  return Array.isArray(preview) ? (preview as SuggestablePost[]) : [];
}

export type SuggestedPostsResult = {
  suggestions: SuggestedPost[];
  /** `extractPostsCollectedAt` 은 aiTags 안의 원시 값이라 문자열일 수 있다(JSON 직렬화 대상). */
  lastCollectedAt: string | Date | null;
  /** 콘텐츠를 공유하는 캠페인 id 집합(그룹이면 멤버 전체) — 상세 화면의 등록 게시물 필터용. */
  sharedCampaignIds: string[];
  /** 검토 기간(마감 +7일) 종료 여부 — **창의 사실**이라 includeClosed 와 무관하게 실제 상태다. */
  reviewClosed: boolean;
};

/**
 * 캠페인(그룹이면 멤버 전체)의 미등록 홍보 후보를 계산한다. 읽기 전용·신규 수집 트리거 없음.
 *
 * 검토 기간이 지난 캠페인은 `includeClosed` 없이는 후보를 접는다 — 수집은 셀러 단위라 다른
 * 캠페인 때문에 계속 돌지만, 이 캠페인의 후보 집합은 수집창이 닫힌 시점에 확정돼 더 늘지
 * 않는다(오너 2026-07-31). 그 경우 등록 자산·분류 조회와 프리뷰 계산이 통째로 생략된다.
 */
export async function loadSuggestedPosts(
  prisma: PrismaClient,
  campaign: { id: string; sellerId: string; startDate: Date | null; endDate: Date | null; groupId: string | null },
  options: { includeClosed?: boolean } = {},
): Promise<SuggestedPostsResult> {
  // 그룹(조합) 캠페인은 홍보 게시물을 그룹 전체가 공유한다(오너 2026-07-13) — 등록 dedup과
  // 후보 기간 창을 그룹 스코프(멤버 전체·기간 포락선)로 계산한다. 미그룹이면 자기 자신뿐.
  const scope = await resolveCampaignContentScope(prisma, campaign);

  // 셀러의 수집 피드(영속된 프리뷰) — 없으면 빈 배열(분석 전 셀러 → 추천 없음, 에러 아님).
  // 수집시각 표시는 일간 크론의 postsCollectedAt(aiTags 내) 우선, analyzedAt(analyze 경로) 폴백
  // — 일간 크론은 analyzedAt(AI 분석 신선도)을 안 건드리므로 둘을 구분해야 표시가 정확하다.
  const profile = await prisma.sellerAiProfile.findUnique({
    where: { sellerId: campaign.sellerId },
    select: { aiTags: true, analyzedAt: true },
  });
  const postsPreview = extractPostsPreview(profile?.aiTags);
  const postsCollectedAt = extractPostsCollectedAt(profile?.aiTags);
  const lastCollectedAt = postsCollectedAt ?? profile?.analyzedAt ?? null;

  const reviewClosed = !isContentReviewOpen(scope.endDate);
  if (reviewClosed && !options.includeClosed) {
    return { suggestions: [], lastCollectedAt, sharedCampaignIds: scope.campaignIds, reviewClosed };
  }

  // 이미 이 캠페인(그룹이면 멤버 전체)에 등록된 셀러 게시물 URL — 후보에서 제외(중복 제시 방지).
  const registered = await prisma.asset.findMany({
    where: {
      entityType: "CAMPAIGN",
      entityId: { in: scope.campaignIds },
      archivedAt: null,
      externalUrl: { not: null },
    },
    select: { externalUrl: true },
  });
  const registeredUrls = registered
    .map((a) => a.externalUrl)
    .filter((u): u is string => typeof u === "string");

  // "무관(OTHER)"으로 분류된 게시물 — 후보에서 영구 제외(오너 결정4). 홍보(CAMPAIGN)는 이 테이블에
  // 저장되지 않으므로(Asset이 SSOT) OTHER만 조회한다.
  const dismissed = await prisma.sellerPostClassification.findMany({
    where: { sellerId: campaign.sellerId, classification: "OTHER" },
    select: { permalink: true },
  });
  const dismissedUrls = dismissed.map((d) => d.permalink);

  const suggestions = suggestCampaignPosts(postsPreview, {
    startDate: scope.startDate,
    endDate: scope.endDate,
    registeredUrls,
    dismissedUrls,
  }).slice(0, MAX_SUGGESTIONS);

  return { suggestions, lastCollectedAt, sharedCampaignIds: scope.campaignIds, reviewClosed };
}
