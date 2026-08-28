// posts-preview-merge — analyze 재실행 시 postsPreview 유실 방지(오너 2026-07-13, 증분 판단).
//
// 배경: /api/sellers/[id]/analyze는 매 실행 raw_posts 최근 N개로 postsPreview를 통째 덮어쓴다.
// 캠페인 창(시작−7d~마감+1d)에 걸린 게시물이 다음 재분석 때 최근 N개 밖으로 밀려나면 후보에서
// 사라진다(아직 홍보/무관으로 리뷰되기 전이면 검토 기회 소실). Graph API business_discovery.media는
// since/after 커서를 안 줘서 "증분 fetch"는 불가하므로, 쓰기 측에서 이전 프리뷰를 permalink 기준으로
// 보존 병합한다. 홍보(Asset)·무관(SellerPostClassification)은 이미 독립 영속이라 이 병합과 무관하다.
import { isAdPost, isGonguPost } from "./metrics";
import { isStablePostThumb } from "./mediaRehost";
import { isRehostedUrl } from "./seller-media-storage";
import type { PostPreview, RawPost } from "./types";

/**
 * RawPost → PostPreview 매핑 SSOT — analyze 라우트와 일간 캠페인 게시물 크론
 * (campaign-posts-refresh)이 공유한다(두 경로가 각자 매핑하면 필드 드리프트로 likes_hidden 유실류
 * 버그 재발). 캡션·댓글 원문 미저장(§8 개인정보 원칙), 광고/공구 판정은 수집 시점 계산.
 */
export function toPostsPreview(rawPosts: RawPost[], limit = 30): PostPreview[] {
  return rawPosts.slice(0, limit).map((p) => ({
    thumb: p.thumbnail_url ?? null,
    taken_at: p.taken_at,
    likes: p.likes || 0,
    // 좋아요 숨김 신호 보존 — 없으면 숨김 계정이 "좋아요 0"으로 오표기(RawPost→PostPreview 유실 버그)
    likes_hidden: p.likes_hidden === true,
    comments: p.comments_count || 0,
    media_type: p.media_type,
    video_views: p.video_view_count,
    is_ad: isAdPost(p),
    is_gongu: isGonguPost(p),
    video_url: p.video_url ?? null,
    // 영상 파일은 미호스팅(비용) — 클릭 시 인스타 원본에서 재생하도록 퍼머링크만 보존
    permalink: p.shortcode ? `https://www.instagram.com/p/${p.shortcode}/` : null,
  }));
}

/** postsPreview 항목의 병합 키 — permalink(정규화 전 원본이라도 문자열 동일성으로 dedup). */
function keyOf(p: PostPreview): string | null {
  return typeof p.permalink === "string" && p.permalink ? p.permalink : null;
}

/**
 * 새 프리뷰(fresh)를 우선하고, 이전 프리뷰(existing) 중 fresh에 없는 항목을 최신순 뒤에 이어 붙여
 * cap개까지 보존한다. permalink 없는 항목은 dedup 불가라 fresh에서만 그대로 통과(existing 쪽은 제외).
 * 순수 함수 — 정렬은 입력 순서(둘 다 최신순 전제)를 유지하고, 동일 permalink는 fresh 값으로 대체하되
 * **thumb만은 예외**: existing이 이미 안정(shortcode 키) 재호스팅 URL이면 그걸 보존한다.
 * fresh의 fbcdn URL로 리셋하면 매일 같은 이미지를 다시 받아 올리는 낭비가 되고, 만료 창에서
 * placeholder로 깜빡일 수 있다. 레거시 인덱스 키 URL은 보존하지 않는다(내용물이 다른 게시물로
 * 덮였을 수 있음 — isStablePostThumb가 걸러냄, 2026-07-16 오염 실사고).
 */
export function mergePostsPreview(
  fresh: PostPreview[],
  existing: PostPreview[],
  cap: number,
): PostPreview[] {
  const stableThumbByKey = new Map<string, string>();
  for (const p of existing) {
    const k = keyOf(p);
    if (k && isStablePostThumb(p.thumb, p.permalink)) {
      stableThumbByKey.set(k, p.thumb as string);
    }
  }
  const seen = new Set<string>();
  const out: PostPreview[] = [];
  for (const p of fresh) {
    const k = keyOf(p);
    if (k) seen.add(k);
    const stableThumb = k ? stableThumbByKey.get(k) : undefined;
    out.push(stableThumb ? { ...p, thumb: stableThumb } : p);
    if (out.length >= cap) return out;
  }
  for (const p of existing) {
    const k = keyOf(p);
    if (!k || seen.has(k)) continue; // 키 없음(중복판정 불가) 또는 이미 fresh에 있음 → 건너뜀
    seen.add(k);
    // 방어선: 버킷 URL인데 자기 shortcode 키가 아니면(레거시 인덱스 키 등) 파일 내용이 다른
    // 게시물일 수 있다 — 잘못된 이미지를 이어 나르느니 placeholder(null)로 끊는다. 백필이
    // 일괄 정리했지만, 그 이후 유입되는 예외적 잔존도 코드가 스스로 차단해야 한다.
    const suspect = isRehostedUrl(p.thumb) && !isStablePostThumb(p.thumb, p.permalink);
    out.push(suspect ? { ...p, thumb: null } : p);
    if (out.length >= cap) break;
  }
  return out;
}
