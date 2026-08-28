// Apify instagram-comment-scraper 어댑터 — Tier0(Graph BD)의 댓글 공백을 보조 수집 (스펙 §12′).
// 과금은 결과(댓글) 수 비례 ~$2.30/1k — 공구글 우선 10게시물×15개 ≈ 150개 ≈ $0.35/계정
// (월 $5 무료 크레딧으로 ~14계정). 타깃팅으로 지출을 구매의도 신호가 가장 진한 곳에 집중한다.
import { getApifyToken } from './apify';
import {
  describeApifyToken,
  truncateReason,
  NO_HTTP_RESPONSE,
  type ApifyCommentFetchUsage,
} from './apify-comment-usage';
import { isGonguPost } from './metrics';
import { collapseRepostDuplicates } from './post-dedup';
import { RawPost } from './types';
import { shortcodeFromPermalink } from './graphScraper';

const COMMENT_ACTOR_ID = 'apify~instagram-comment-scraper';
export const COMMENT_TARGET_POSTS = 10;
export const COMMENTS_PER_POST = 15;

/**
 * `ApiCallLog.endpoint` 라벨 — **호스트도 쿼리도 없는 경로만** 쓴다.
 * 실제 요청 URL 에는 `?token=` 이 붙으므로 그대로 남기면 시크릿이 DB 로 샌다(P0).
 */
export const COMMENT_ENDPOINT_LABEL = `POST /v2/acts/${COMMENT_ACTOR_ID}/run-sync-get-dataset-items`;

/**
 * 댓글 수집 타깃 선정 (순수 — 단위테스트 대상): 공구글 우선, 남는 슬롯은 일반글로 채움.
 * 댓글 구매의도 분류(Gemini comment_analysis)는 공구글 댓글에서 가장 결정적이라는 판단.
 * shortcode 없는 게시물은 URL을 만들 수 없어 제외. 입력 순서(피드 최신순)를 각 그룹 안에서 보존.
 * 재업로드 사본은 접고 대표만 타깃한다 — 같은 콘텐츠에 유료 댓글 수집을 이중 지출하지 않고,
 * 사본이 공구글 슬롯(10개)을 잠식해 다른 게시물의 댓글 신호를 밀어내는 것을 막는다.
 */
export function pickCommentTargets(posts: RawPost[], max = COMMENT_TARGET_POSTS): RawPost[] {
  const eligible = collapseRepostDuplicates(posts).filter((p) => p.shortcode);
  const gongu = eligible.filter((p) => isGonguPost(p));
  const rest = eligible.filter((p) => !isGonguPost(p));
  return [...gongu, ...rest].slice(0, max);
}

/** 액터 출력(댓글 1개=1아이템, postUrl로 소속 식별)을 shortcode → 텍스트[]로 그룹핑 (순수 — 단위테스트 대상) */
export function groupCommentsByShortcode(items: any[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const code = shortcodeFromPermalink(item?.postUrl ?? item?.url ?? item?.postLink);
    const text = typeof item?.text === 'string' && item.text.trim() ? item.text : null;
    if (!code || !text) continue;
    const arr = map.get(code) ?? [];
    arr.push(text);
    map.set(code, arr);
  }
  return map;
}

export type CommentFetchOutcome = {
  byShortcode: Map<string, string[]>;
  usage: ApifyCommentFetchUsage;
};

/**
 * 지정 게시물들의 댓글을 Apify 동기 실행으로 수집해 shortcode → 텍스트[] 맵으로 반환하고,
 * **같은 호출의 관측치(`usage`)를 함께 돌려준다** — 지출이 결과 수 비례라 수신 댓글 수가 곧 비용이다.
 *
 * ⚠️ 계약 변경(계측 도입): HTTP·네트워크 실패로 **throw 하지 않는다.** 실패도 관측 대상이라
 * `usage.ok=false` + `errorMessage` 로 돌려주고, 기록 책임은 호출부에 있다(성공·실패 양쪽 1행씩).
 * 예전처럼 throw 하면 실패 경로가 호출부의 catch 로 새면서 관측치를 통째로 잃는다.
 */
export async function fetchCommentsByShortcode(
  shortcodes: string[],
  commentsPerPost = COMMENTS_PER_POST
): Promise<CommentFetchOutcome> {
  const startedAt = Date.now();
  const base = {
    targetPosts: shortcodes.length,
    receivedComments: 0,
    postsWithComments: 0,
    statusCode: NO_HTTP_RESPONSE,
    endpoint: COMMENT_ENDPOINT_LABEL,
    tokenFingerprint: null as string | null,
  };
  const elapsed = () => Date.now() - startedAt;

  if (shortcodes.length === 0) {
    // 호출 자체가 없었으므로 지출도 없다 — 기록 대상이 아니다(호출부가 usage.ok 로 구분).
    return {
      byShortcode: new Map(),
      usage: { ...base, ok: true, durationMs: elapsed(), errorMessage: null },
    };
  }

  const token = getApifyToken();
  if (!token) {
    return {
      byShortcode: new Map(),
      usage: { ...base, ok: false, durationMs: elapsed(), errorMessage: 'APIFY_API_TOKEN is missing.' },
    };
  }
  base.tokenFingerprint = describeApifyToken(token);

  try {
    // /p/{code}/는 릴스여도 원본으로 리다이렉트되므로 단일 포맷으로 충분
    const directUrls = shortcodes.map((c) => `https://www.instagram.com/p/${c}/`);
    const res = await fetch(
      `https://api.apify.com/v2/acts/${COMMENT_ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directUrls, resultsLimit: commentsPerPost }),
      }
    );
    base.statusCode = res.status;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        byShortcode: new Map(),
        usage: {
          ...base,
          ok: false,
          durationMs: elapsed(),
          errorMessage: truncateReason(`Apify comment run failed: ${body}`),
        },
      };
    }

    const items = await res.json();
    const list = Array.isArray(items) ? items : [];
    const byShortcode = groupCommentsByShortcode(list);
    return {
      byShortcode,
      usage: {
        ...base,
        // 과금 단위는 액터가 돌려준 결과 수 자체다 — 우리가 파싱에 성공한 수(그룹핑 후)가 아니다.
        receivedComments: list.length,
        postsWithComments: byShortcode.size,
        ok: true,
        durationMs: elapsed(),
        errorMessage: null,
      },
    };
  } catch (error) {
    // 네트워크 오류·본문 파싱 실패 — 여기서 throw 하면 지출 관측이 사라진다.
    return {
      byShortcode: new Map(),
      usage: { ...base, ok: false, durationMs: elapsed(), errorMessage: truncateReason(error) },
    };
  }
}
