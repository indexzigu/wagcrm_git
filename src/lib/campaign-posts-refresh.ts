// 진행 캠페인 "콘텐츠 발행 확인"용 일간 게시물(피드+릴스) 수집 — 오너 요건(2026-07-13):
// 캠페인 수집창(시작 −7일 ~ 마감 +1일) 동안 셀러가 뭘 올렸는지 매일 자동으로 잡혀야 한다.
// 스토리(capture-stories)와 대칭인 게시물 쪽 일간 경로다.
//
// 소스는 무료 Tier0(Graph business_discovery)만 쓴다 — 유료 폴백 워터폴(seller-analysis/scraper)
// 은 여기서 부르지 않는다(Collection Cost Guard·유료 호출자 화이트리스트 계약). Tier0가 실패하는
// 셀러(개인계정 등)는 에러로 표면화만 하고 건너뛴다 — 그런 셀러는 수동 analyze 버튼(워터폴 승인
// 경로)이 담당한다.
//
// Gemini 분석은 돌리지 않는다: postsPreview(캠페인 후보 피드)와 postsCollectedAt(aiTags 내
// 타임스탬프)만 갱신하고 analyzedAt(AI 분석 신선도·"재분석 권장" 라벨의 근거)은 건드리지 않는다.
// 썸네일 리호스팅은 일간 rehost-seller-media 크론이 후속 청소한다(analyze의 after() 경로와 동일).
import type { PrismaClient } from "@prisma/client";
import { listCaptureWindowSellers, startOfKstDay } from "@/lib/story-capture";
import { isGraphConfigured, scrapeTier0 } from "@/lib/seller-analysis/graphScraper";
import { applyDbInstagramToken } from "@/lib/instagram-token";
import { mergePostsPreview, toPostsPreview } from "@/lib/seller-analysis/posts-preview-merge";
import type { PostPreview } from "@/lib/seller-analysis/types";

/** 재분석 보존 병합 상한 — analyze 라우트(POSTS_PREVIEW_CAP)와 동일 값 유지. */
export const CAMPAIGN_POSTS_PREVIEW_CAP = 45;

export type CampaignPostsRefreshResult = {
  /** 수집창 안 인스타 셀러 총수(일일 게이트 스킵 전) */
  activeSellers: number;
  refreshed: number;
  /** 오늘(KST) 이미 갱신돼 건너뛴 셀러 수(일일 중복 방지 게이트, force로 우회) */
  skipped: number;
  errors: string[];
};

function asRecord(aiTags: unknown): Record<string, unknown> {
  return aiTags && typeof aiTags === "object" && !Array.isArray(aiTags)
    ? (aiTags as Record<string, unknown>)
    : {};
}

/** aiTags에서 postsCollectedAt(ISO 문자열)을 방어적으로 꺼낸다 — 표시 계층과 일일 게이트가 공용. */
export function extractPostsCollectedAt(aiTags: unknown): string | null {
  const v = asRecord(aiTags).postsCollectedAt;
  return typeof v === "string" && v ? v : null;
}

/**
 * 진입점 — 수집창 안 캠페인 셀러 전원의 게시물 프리뷰를 Tier0로 갱신한다. 멱등: permalink 기준
 * 보존 병합(mergePostsPreview)이라 재실행돼도 후보가 늘거나 유실되지 않는다. 셀러별 에러는 격리.
 *
 * sellerIds 를 주면 창 안 셀러와의 **교집합**으로만 좁힌다(캠페인 상세 셀러별 수동 수집 —
 * captureActiveCampaignStories 와 동일 의미론). 창 판정은 우회하지 않는다: 창 밖 셀러는 대상
 * 0으로 정직하게 끝난다.
 */
export async function refreshCampaignWindowPosts(
  prisma: PrismaClient,
  now = new Date(),
  force = false,
  sellerIds?: string[],
): Promise<CampaignPostsRefreshResult> {
  const errors: string[] = [];
  const windowSellers = await listCaptureWindowSellers(prisma, now);
  const sellerFilter = sellerIds ? new Set(sellerIds) : null;
  const sellers = sellerFilter
    ? windowSellers.filter((s) => sellerFilter.has(s.id))
    : windowSellers;
  const result: CampaignPostsRefreshResult = {
    activeSellers: sellers.length,
    refreshed: 0,
    skipped: 0,
    errors,
  };
  if (sellers.length === 0) return result;

  // 🪤 **게이트보다 먼저 DB 토큰을 프로세스 env 에 얹는다** — 이 한 줄이 없으면 판정이
  // 「같은 Node 프로세스에서 다른 수집 진입점이 먼저 돌았는가」에 좌우된다(2026-08-26 실사고).
  // 장기 토큰은 60일 만료라 `.env` 가 아니라 DB(`SystemSettings`)가 정본이고, 서버는 자기
  // env 를 갱신할 수 없어 `applyDbInstagramToken()` 이 실행 시점에 덮어쓰는 구조다
  // (`instagram-token.ts` 머리말). 그 함수가 프로세스 전역을 건드리는 부수효과라서, 앞서
  // 돈 크론이 채워 두면 여기서도 우연히 통과하고 앱 재시작 뒤 회차부터 다시 실패한다 —
  // 실제로 하루는 갱신되고 다음 이틀은 0건이었는데 크론 상태는 세 회차 모두 SUCCESS 였다.
  // ⛔ 이 호출을 라우트로 올리지 말 것: 게이트와 토큰 적용이 떨어지면 같은 사고가 재발한다
  // (`instagram-graph-token-applied.contract.test.ts` 가 짝을 고정한다).
  await applyDbInstagramToken();
  if (!isGraphConfigured()) {
    // 조용히 성공으로 위장하지 않는다(P0 무음 실패 금지) — 크론 레이더에 그대로 표면화.
    errors.push("INSTAGRAM_ACCESS_TOKEN/BUSINESS_ACCOUNT_ID 미설정: Tier0 수집 불가");
    return result;
  }

  const todayStart = startOfKstDay(now);
  for (const seller of sellers) {
    const profile = await prisma.sellerAiProfile.findUnique({
      where: { sellerId: seller.id },
      select: { aiTags: true },
    });
    const aiTags = asRecord(profile?.aiTags);

    // 일일 게이트 — 오늘(KST) 이미 갱신됐으면 Graph 호출을 건너뛴다(스토리 크론과 동일 관례).
    if (!force) {
      const prev = extractPostsCollectedAt(aiTags);
      if (prev && new Date(prev) >= todayStart) {
        result.skipped += 1;
        continue;
      }
    }

    try {
      const data = await scrapeTier0(seller.handle);
      const fresh = toPostsPreview(data.raw_posts);
      const existing = Array.isArray(aiTags.postsPreview)
        ? (aiTags.postsPreview as PostPreview[])
        : [];
      const merged = mergePostsPreview(fresh, existing, CAMPAIGN_POSTS_PREVIEW_CAP);
      const nextTags = { ...aiTags, postsPreview: merged, postsCollectedAt: now.toISOString() };
      // analyzedAt·compositeScore 등 AI 분석 필드는 불변 — aiTags만 갱신(프로필 없으면 최소 생성).
      // as object 캐스팅은 Prisma Json 입력 타입 관례(analyze 라우트와 동일).
      await prisma.sellerAiProfile.upsert({
        where: { sellerId: seller.id },
        create: { sellerId: seller.id, aiTags: nextTags as object },
        update: { aiTags: nextTags as object },
      });
      result.refreshed += 1;
    } catch (e) {
      errors.push(`${seller.handle}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
