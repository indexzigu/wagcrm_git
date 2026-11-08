// 셀러 분석 데이터 형상 타입 — 스크래핑 클라이언트(apify)에서 분리해 로직 모듈을 자립시킨다.
// 원천: influencer-commerce-admin/src/lib/apify.ts 의 타입·순수 헬퍼 부분만 이관 (스크래핑 클라이언트 로직 제외).
// metrics.ts 및 향후 WAGCRM 데이터 어댑터(§12-2)가 이 타입/헬퍼를 소비한다. 외부 의존성 없음.

export type MediaType = 'image' | 'video' | 'reel' | 'carousel' | 'unknown';

/** 조회수 원천 — views(조회) · plays(재생). 인스타가 두 수치를 따로 주므로 섞어 비교하지 않는다 */
export type VideoViewSource = 'views' | 'plays';

export interface RawPost {
  caption: string;
  likes: number;
  /** 좋아요 숨김 신호 — Graph BD가 like_count를 생략하면 true(likes는 0 센티널로 남음).
   *  캠페인 자산 지표 배선(campaign-post-engagement)이 "비공개" 표기에 소비. 타 티어는 미설정. */
  likes_hidden?: boolean;
  comments_count: number;
  sample_comments: string[];
  taken_at: string | null; // ISO 8601, 없으면 null
  media_type: MediaType;
  video_view_count: number | null;
  /** [셀러분석] video_view_count 가 어느 원천 필드에서 왔는가 — 수집 경로마다 다르다(Apify 는
   *  videoViewCount 우선·videoPlayCount 폴백, RapidAPI 는 play_count 우선·view_count 폴백).
   *  릴스 조회 배수(metrics.reach)가 「기준 다름」을 판정하는 근거. 조회수가 없거나(Tier0)
   *  기록 이전 경로면 미설정/null. 폴백 순서 자체는 바꾸지 않는다(저장된 프리뷰 의미 보존). */
  view_source?: VideoViewSource | null;
  is_sponsored: boolean;
  /** 릴스/비디오 원본 MP4 주소 (재호스팅 안 함, Hover-to-Play 용도) */
  video_url?: string | null;
  /** 미디어 썸네일 URL (인스타 CDN 참조 — 재호스팅 안 함, 만료 시 placeholder 축소. 스펙 §8) */
  thumbnail_url?: string | null;
  /** 게시물 shortcode — 클릭 시 인스타 원본(영상 재생 포함)으로 링크. 영상 파일 미호스팅의 저비용 보완 */
  shortcode?: string | null;
}

/** T3 피드 프리뷰용 슬림 게시물 스냅샷 — 캡션·댓글 원문 미포함(§8 개인정보 원칙), 판정(광고/공구)은 수집 시점 계산 */
export interface PostPreview {
  thumb: string | null;
  taken_at: string | null;
  likes: number;
  /** 좋아요 숨김 신호 — Graph BD가 like_count를 생략한 계정(likes는 0 센티널로 남음).
   *  RawPost.likes_hidden에서 전파(analyze route). 표시 계층이 "비공개" 표기에 소비 —
   *  이게 없으면 숨김 계정이 "좋아요 0"으로 오표기된다(나리 등 팔로워 다수·전 게시물 0). */
  likes_hidden?: boolean;
  comments: number;
  media_type: MediaType;
  video_views: number | null;
  is_ad: boolean;
  is_gongu: boolean;
  /** 릴스/비디오 원본 MP4 주소 (Hover-to-Play 자동 재생 용도) */
  video_url?: string | null;
  /** 재호스팅 실패 마킹(만료 403 등 — 재시도 안 함, mediaRehost.ts). 원본 URL은 유지 */
  thumbFailed?: boolean;
  /** 인스타 원본 게시물 URL — 클릭 시 새 탭(영상은 원본에서 재생, 파일 미호스팅 보완) */
  permalink?: string | null;
}

export interface LosslessSellerData {
  seller_id: string;
  source_tier?: string;
  debug_info?: string;
  /**
   * Owner-facing one-liner (Korean) set only when paid reel-view enrichment was requested but
   * did not run or failed for a reason the owner should know (monthly cap, missing token, spend
   * lookup failure, actor failure). The analyze route returns it so the button can show a toast;
   * otherwise a capped month looks identical to "no data".
   */
  reel_views_notice?: string;
  profile: any;
  raw_posts: RawPost[];
  images: string[];
}

// 티어별로 이질적인 media_type 표기(문자열 "Image"/"Video"/"Sidecar", 숫자 1/2/8, product_type "clips",
// Graph API "IMAGE"/"VIDEO"/"CAROUSEL_ALBUM" + media_product_type "REELS")를 통일
export function normalizeMediaType(rawType: unknown, productType?: unknown): MediaType {
  if (typeof productType === 'string') {
    const p = productType.toLowerCase();
    if (p === 'clips' || p === 'reels') return 'reel';
  }
  if (typeof rawType === 'number') {
    if (rawType === 1) return 'image';
    if (rawType === 2) return 'video';
    if (rawType === 8) return 'carousel';
    return 'unknown';
  }
  if (typeof rawType === 'string') {
    const t = rawType.toLowerCase();
    if (t === 'image' || t === 'graphimage' || t === 'photo') return 'image';
    if (t === 'reel' || t === 'clips') return 'reel';
    if (t === 'video' || t === 'graphvideo') return 'video';
    if (t === 'sidecar' || t === 'graphsidecar' || t === 'carousel' || t === 'carousel_album') return 'carousel';
  }
  return 'unknown';
}

// ISO 문자열 또는 unix 초/밀리초 타임스탬프를 ISO 8601 문자열로 변환. 해석 불가하면 null.
// 단위 오판정 방지: 1e12 이상 숫자는 밀리초로 간주하고, 변환 결과가 2000년~현재+1년
// 범위를 벗어나면 단위 오판정으로 보고 null 반환 (쓰레기 날짜가 cadence 지표를 오염시키는 것 차단).
export function toIsoTimestamp(value: unknown, now: Date = new Date()): string | null {
  let ms: number | null = null;
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (/^\d+$/.test(s)) return toIsoTimestamp(Number(s), now); // 숫자만 있는 문자열은 숫자와 동일 규칙 적용
    const parsed = new Date(s).getTime();
    ms = isNaN(parsed) ? null : parsed;
  } else if (typeof value === 'number' && isFinite(value) && value > 0) {
    ms = value >= 1e12 ? value : value * 1000; // 13자리 이상은 밀리초, 그 외 초 단위로 가정
  }
  if (ms === null) return null;
  const min = Date.UTC(2000, 0, 1);
  const max = now.getTime() + 365 * 24 * 60 * 60 * 1000;
  if (ms < min || ms > max) return null;
  return new Date(ms).toISOString();
}

// ---------- 조회수 원천 판정 (수집 시점 기록 — 폴백 순서는 종전 그대로) ----------

export interface PickedVideoView {
  count: number | null;
  source: VideoViewSource | null;
}

/**
 * Apify posts 액터 항목의 조회수. 순서는 종전 식
 * `videoViewCount ?? engagement.video_view_count ?? videoPlayCount` 와 **완전히 같다** —
 * `??` 가 멈춘 자리(첫 non-nullish)가 원천이다. 그 값이 숫자가 아니면 조회수 없음.
 */
export function pickApifyVideoView(item: any): PickedVideoView {
  const candidate = item?.videoViewCount ?? item?.engagement?.video_view_count ?? item?.videoPlayCount;
  if (typeof candidate !== 'number') return { count: null, source: null };
  const fromViews = item?.videoViewCount != null || item?.engagement?.video_view_count != null;
  return { count: candidate, source: fromViews ? 'views' : 'plays' };
}

/** RapidAPI userposts 항목의 조회수 — 종전 식 `play_count ?? view_count` 와 같은 순서. */
export function pickRapidApiVideoView(item: any): PickedVideoView {
  const candidate = item?.play_count ?? item?.view_count;
  if (typeof candidate !== 'number') return { count: null, source: null };
  return { count: candidate, source: item?.play_count != null ? 'plays' : 'views' };
}
