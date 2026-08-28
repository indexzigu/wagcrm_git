// campaign-post-engagement — 캠페인 셀러 게시물 Asset ↔ Graph Tier0 게시물 매칭의 순수 로직.
// 크론 어댑터(collectors/campaign-engagement-collector)가 소비한다: 셀러당 무료 Graph BD 1콜의
// raw_posts를 shortcode로 캠페인 Asset(EXTERNAL_LINK)에 대응시켜 구조화 지표 업데이트를 산출한다.
// 네트워크·DB 접근 없음 — 전부 단위테스트 대상.
//
// 3-state 규약(오너 결정 2026-07-11, 출력 규약 계약 테스트가 강제):
// - likeCount=null · likesHidden=null  → 미집계(Tier0 창 밖·미매칭)
// - likeCount=숫자 · likesHidden=false → 집계값
// - likeCount=null · likesHidden=true  → 좋아요 숨김("비공개" 표기, 임의 숫자 저장 금지)
import { instagramShortcode } from "./instagram-embed";
import type { RawPost } from "./seller-analysis/types";

/** 매칭에 필요한 최소 Asset 형태. */
export type EngagementAssetInput = {
  id: string;
  externalUrl: string | null;
};

/** Asset 1건에 적용할 지표+표현 자산 업데이트 — 어댑터가 그대로 prisma.asset.update data로 쓴다. */
export type AssetEngagementUpdate = {
  assetId: string;
  likeCount: number | null;
  commentCount: number | null;
  likesHidden: boolean;
  // 표현 자산 — 같은 Tier0 응답에서 함께 적재(추가 호출 0, 오너 아젠다: 호출 1회에 수집 가능한 것 전부).
  mediaType: string | null; // normalizeMediaType 값(image/video/reel/carousel/unknown 외는 null)
  videoUrl: string | null; // 릴스/영상 mp4(fbcdn 만료성 — 크론이 매일 갱신해 신선 유지)
  postedAt: Date | null; // 게시 시각(taken_at)
};

const KNOWN_MEDIA_TYPES = new Set(["image", "video", "reel", "carousel", "unknown"]);

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mediaTypeOrNull(v: unknown): string | null {
  return typeof v === "string" && KNOWN_MEDIA_TYPES.has(v) ? v : null;
}

function dateOrNull(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function urlOrNull(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\//.test(v) ? v : null;
}

/**
 * 캠페인 Asset들을 Tier0 raw_posts에 shortcode로 매칭해 지표 업데이트 목록을 만든다.
 * - 매칭 실패(비인스타 URL·shortcode 파싱 불가·Tier0 최근 창(50건) 밖)는 결과에서 제외
 *   — 기존 값(미집계 null 또는 과거 집계값)을 건드리지 않는다.
 * - likes_hidden(BD가 like_count 생략)이면 likeCount=null 고정 — 0이나 센티널을 넣지 않는다.
 * - 댓글 수는 숨김과 무관하게 저장한다(BD는 comments_count를 항상 제공).
 */
export function matchAssetEngagement(
  assets: EngagementAssetInput[],
  rawPosts: RawPost[],
): AssetEngagementUpdate[] {
  const byShortcode = new Map<string, RawPost>();
  for (const p of rawPosts) {
    if (p.shortcode) byShortcode.set(p.shortcode, p);
  }

  const updates: AssetEngagementUpdate[] = [];
  for (const asset of assets) {
    const sc = instagramShortcode(asset.externalUrl);
    if (!sc) continue;
    const post = byShortcode.get(sc);
    if (!post) continue;
    const hidden = post.likes_hidden === true;
    updates.push({
      assetId: asset.id,
      likeCount: hidden ? null : finiteOrNull(post.likes),
      commentCount: finiteOrNull(post.comments_count),
      likesHidden: hidden,
      mediaType: mediaTypeOrNull(post.media_type),
      videoUrl: urlOrNull(post.video_url),
      postedAt: dateOrNull(post.taken_at),
    });
  }
  return updates;
}
