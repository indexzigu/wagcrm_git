/**
 * Apify 댓글 수집 지출 계측 — 호출 1회 = `ApiCallLog` 1행.
 *
 * 왜 필요한가: Tier0(Graph BD, 무료)가 성공해도 댓글 텍스트는 Graph 가 원천
 * 미제공이라 `enrichTier0Comments` 가 유료 액터를 한 번 더 부른다. 그런데 그
 * 결과가 `debug_info` 문자열과 `console.warn` 에만 남아 **월 몇 회 불렀는지 ·
 * 회당 몇 개를 받았는지(과금이 결과 수 비례라 이게 곧 비용) · 실패율이 얼마인지**
 * 를 사후에 알 수 없었다. 실패해도 분석은 진행하도록 설계돼 있어 더 조용히 묻힌다.
 *
 * 왜 새 테이블이 아닌가: `ApiCallLog` 가 이미 provider·endpoint·statusCode·
 * success·errorMessage·metadata 를 갖고 있고, `@@index([permissionScope, calledAt])`
 * 가 월별 집계를 인덱스로 커버한다. 마이그레이션 없이 기존 수집기(instagram·
 * youtube collector)와 같은 패턴을 재사용한다.
 *
 * ⚠️ 이 모듈은 **토큰 값을 절대 저장하지 않는다**(P0). 토큰 구분이 필요하면
 * `describeApifyToken` 의 비가역 지문(sha256 앞 6자)만 쓴다. 계약은
 * `apify-comment-usage.test.ts` 가 기계로 강제한다.
 */
import { createHash } from 'node:crypto';
import { getPrisma } from '@/lib/prisma';

/** `ApiCallLog.permissionScope` 판별자 — 월별 집계 쿼리가 이 값으로 인덱스를 탄다. */
export const APIFY_COMMENT_SCOPE = 'apify_comment_scraper';

/** `ApiCallLog.provider` — 기존 규약(provider=플랫폼, permissionScope=벤더)을 따른다. */
export const APIFY_COMMENT_PROVIDER = 'INSTAGRAM';

/** 결과(댓글) 수 비례 단가. 액터 요금표 기준 ~$2.30/1k. */
export const COMMENT_COST_USD_PER_1K = 2.3;

/** Apify 무료 크레딧(계정당 월 $5) — 월별 리포트의 판정선. */
export const APIFY_FREE_CREDIT_USD_PER_MONTH = 5;

/** HTTP 응답을 받기 전에 끝난 호출(토큰 미설정·네트워크 오류 등)의 statusCode 규약. */
export const NO_HTTP_RESPONSE = 0;

/** 호출 1회의 관측치. `filledPosts` 만 호출부(scraper)가 채운다 — 아래 주석 참조. */
export type ApifyCommentCallUsage = {
  /** 액터에 넘긴 게시물 수 = 지출 상한의 근거 */
  targetPosts: number;
  /** 실제 수신 댓글 수 = **과금 단위**(결과 수 비례) */
  receivedComments: number;
  /** 액터가 댓글을 돌려준 게시물 수 */
  postsWithComments: number;
  /**
   * 분석 페이로드에 실제로 주입된 게시물 수. `postsWithComments` 와 갈라질 수 있다 —
   * 액터가 요청한 shortcode 가 아닌 다른 코드로 돌려주면(리다이렉트) 귀속이 안 된다.
   * 두 수의 차이가 곧 "돈은 썼는데 못 쓴 댓글"이라 따로 기록한다.
   */
  filledPosts: number;
  durationMs: number;
  /** HTTP 상태. 응답 전 실패는 `NO_HTTP_RESPONSE`(0). */
  statusCode: number;
  ok: boolean;
  /** 실패 사유(성공이면 null). 본문은 앞부분만 잘라 남긴다. */
  errorMessage: string | null;
  /** 토큰 **지문**(비가역). 값이 아니다. 풀 어느 계정이 소진됐는지 사후 추적용. */
  tokenFingerprint: string | null;
  /** 호출 대상 — 호스트·쿼리(=토큰) 없는 경로 라벨 */
  endpoint: string;
};

/** 호출 시점에 알 수 있는 부분(귀속 결과인 `filledPosts` 제외) */
export type ApifyCommentFetchUsage = Omit<ApifyCommentCallUsage, 'filledPosts'>;

/**
 * 토큰의 비가역 식별자 — sha256 앞 6자. 원문 복원 불가이므로 로그에 남겨도 안전하다.
 * 풀(`APIFY_API_TOKENS`)에서 어느 계정이 소진됐는지 사후 추적하는 용도.
 */
export function describeApifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return createHash('sha256').update(token).digest('hex').slice(0, 6);
}

/** 수신 댓글 수 → 추정 비용(USD). 소수 4자리로 반올림. */
export function estimateCommentCostUsd(receivedComments: number): number {
  if (!Number.isFinite(receivedComments) || receivedComments <= 0) return 0;
  return Math.round((receivedComments / 1000) * COMMENT_COST_USD_PER_1K * 10000) / 10000;
}

/** 실패 사유 문자열 정규화 — 개행 접기 + 상한(응답 본문이 통째로 들어오는 것 방지). */
export function truncateReason(raw: unknown, max = 300): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length > max ? `${folded.slice(0, max)}…` : folded;
}

/**
 * `ApiCallLog.metadata` 에 담을 객체(순수 — 단위테스트 대상).
 * **여기에 들어가는 키를 늘릴 때는 시크릿이 아닌지 먼저 확인할 것**(P0).
 */
export function buildCommentUsageMetadata(usage: ApifyCommentCallUsage) {
  return {
    targetPosts: usage.targetPosts,
    receivedComments: usage.receivedComments,
    postsWithComments: usage.postsWithComments,
    filledPosts: usage.filledPosts,
    /** 돈은 썼는데 게시물에 귀속 못 한 수(0이 정상) */
    unattributedPosts: Math.max(0, usage.postsWithComments - usage.filledPosts),
    durationMs: usage.durationMs,
    estimatedCostUsd: estimateCommentCostUsd(usage.receivedComments),
    costPerThousandUsd: COMMENT_COST_USD_PER_1K,
    tokenFingerprint: usage.tokenFingerprint,
  };
}

/**
 * 호출 결과를 `ApiCallLog` 에 영속한다. **성공·실패 양쪽 다 부른다**(P0 No Silent Failure).
 * 계측이 본 작업을 깨뜨리면 안 되므로 쓰기 실패는 콘솔로만 표면화한다 —
 * 기존 수집기(`instagram-collector`·`youtube-collector`)의 `logApiCall` 과 동일한 규약.
 */
export async function recordApifyCommentUsage(usage: ApifyCommentCallUsage): Promise<void> {
  try {
    await getPrisma().apiCallLog.create({
      data: {
        provider: APIFY_COMMENT_PROVIDER,
        permissionScope: APIFY_COMMENT_SCOPE,
        endpoint: usage.endpoint,
        statusCode: usage.statusCode,
        success: usage.ok,
        errorMessage: usage.errorMessage,
        metadata: JSON.stringify(buildCommentUsageMetadata(usage)),
      },
    });
  } catch (err) {
    console.error('[apify-comment-usage] 계측 기록 실패(수집 자체는 영향 없음):', err);
  }
}
