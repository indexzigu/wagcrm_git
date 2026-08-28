// Tier 0: Instagram Graph API business_discovery — 공식·무료 수집 경로 (스펙 §12′ 수집 아키텍처 전환, 2026-07-07 실측).
// - 비즈니스/크리에이터 계정만 조회 가능: 개인계정·미존재 핸들은 BD 에러 → 워터폴(scraper.ts)이 Apify posts로 폴백
// - 댓글 텍스트 미제공 → scraper.ts가 Apify comment-scraper(apifyComments.ts)로 보조 주입
// - is_sponsored 플래그 미제공 → 광고 판정은 캡션 감지(metrics.isAdPost)에 의존
// - video_view_count 미제공 → null (metrics가 결측 허용)
import { LosslessSellerData, RawPost, normalizeMediaType, toIsoTimestamp } from './types';

const GRAPH_VERSION = 'v23.0';
// Apify 30개는 결과수 비례 과금이라 축소했지만(2026-07-06), Graph는 media.limit(50) 1콜 무료 실측(2026-07-07) — 표본 복원
const MEDIA_LIMIT = 50;

export function isGraphConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
}

/** permalink(instagram.com/p|reel|tv/{code}/)에서 shortcode 역산 — BD는 shortcode 필드가 없음 */
export function shortcodeFromPermalink(permalink: unknown): string | null {
  if (typeof permalink !== 'string') return null;
  const m = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(permalink);
  return m ? m[1] : null;
}

/** BD 응답 → LosslessSellerData 매핑 (순수 — 단위테스트 대상) */
export function mapBusinessDiscovery(bd: any, handle: string): LosslessSellerData {
  const media: any[] = bd?.media?.data ?? [];
  const raw_posts: RawPost[] = media.map((item: any) => ({
    caption: item.caption || '',
    likes: item.like_count ?? 0,
    // BD는 소유자가 좋아요를 숨긴 게시물에서 like_count를 생략한다 — 0 센티널과 구분해 보존
    // (캠페인 자산 "비공개" 표기 근거. 임의 숫자 대입 금지 — 오너 결정 2026-07-11).
    likes_hidden: item.like_count == null,
    comments_count: item.comments_count ?? 0,
    sample_comments: [], // BD 미제공 — Apify comment-scraper가 후속 주입 (scraper.ts)
    taken_at: toIsoTimestamp(item.timestamp),
    media_type: normalizeMediaType(item.media_type, item.media_product_type),
    video_view_count: null, // BD 미제공
    is_sponsored: false, // BD 미제공 — isAdPost 캡션 감지에 의존
    // 영상은 thumbnail_url(포스터)만 이미지, media_url은 mp4라 순서 고정. 이미지/캐러셀은 media_url
    video_url: (item.media_type === 'VIDEO' || item.media_product_type === 'REELS') ? item.media_url : null,
    thumbnail_url: item.thumbnail_url || item.media_url || null,
    shortcode: shortcodeFromPermalink(item.permalink),
  }));

  const images = raw_posts.map((p) => p.thumbnail_url).filter(Boolean).slice(0, 10) as string[];
  if (bd?.profile_picture_url) images.unshift(bd.profile_picture_url);

  return {
    seller_id: handle,
    source_tier: 'Tier 0 (Graph API)',
    debug_info: `Graph BD fetched: ${raw_posts.length} posts.`,
    profile: {
      username: bd?.username || handle,
      fullName: bd?.name || '',
      bio: bd?.biography || '',
      follower_count: bd?.followers_count || 0,
      following_count: Number.isFinite(Number(bd?.follows_count)) ? Number(bd.follows_count) : 0,
      media_count: bd?.media_count ?? null, // analyze의 profileMeta.postsCountTotal이 소비
      profilePicUrl: bd?.profile_picture_url || null, // analyze의 Seller 프로필 이미지 동기화가 소비
      website: typeof bd?.website === "string" && bd.website ? bd.website : null, // 바이오 외부링크 — collect-instagram 통합 후 프로필 갱신이 소비
    },
    raw_posts,
    images,
  };
}

export async function scrapeTier0(handle: string): Promise<LosslessSellerData> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!token || !igUserId) throw new Error('INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID 미설정');

  // 핸들은 fields 쿼리 문자열 안에 들어가므로 IG 유저명 문자셋으로 엄격 검증 (신뢰 경계 입력 검증)
  const clean = handle.replace(/^@+/, '').trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(clean)) {
    throw new Error(`인스타그램 핸들 형식이 아닙니다: ${handle}`);
  }

  console.log(`[Tier 0] Starting Graph business_discovery for ${clean}...`);
  const fields =
    `business_discovery.username(${clean}){username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website,` +
    `media.limit(${MEDIA_LIMIT}){caption,like_count,comments_count,timestamp,media_type,media_product_type,media_url,thumbnail_url,permalink}}`;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 개인(비-비즈니스) 계정·미존재 핸들·토큰 만료가 여기로 온다 — 원인을 그대로 표면화하고 워터폴이 폴백 판단
    const err = body?.error;
    const detail = err
      ? `${err.message} (code ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})`
      : `HTTP ${res.status}`;
    throw new Error(`Graph BD failed: ${detail}`);
  }
  const bd = body?.business_discovery;
  if (!bd?.username) throw new Error('Graph BD returned no business_discovery payload.');
  return mapBusinessDiscovery(bd, clean);
}
