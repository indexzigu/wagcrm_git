// reference-enrich — 레퍼런스 링크(EXTERNAL_LINK Asset) 메타데이터 자동 보강의 순수 로직 (R3).
// 크론 라우트(/api/cron/enrich-references)가 소비한다: URL 소스 분류 → 유튜브 무비용 썸네일
// 파생(Apify 0원), 인스타 Apify 응답의 관용(dual-field) 매핑, 자동 메모 생성.
// 네트워크·DB 접근 없음 — 전부 단위테스트 대상.

export type EnrichSource = "INSTAGRAM" | "YOUTUBE" | "UNSUPPORTED";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

/**
 * 레퍼런스 URL을 보강 소스로 분류한다.
 * 인스타/유튜브 호스트만 지원 — 그 외(tiktok/naver 등)·파싱 불가·비 http(s)는 UNSUPPORTED
 * (후속 대상, 크론에서 no-op 스킵되어 비용 0).
 */
export function classifyReferenceUrl(url: string): EnrichSource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "UNSUPPORTED";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "UNSUPPORTED";
  const host = parsed.hostname.toLowerCase();
  if (INSTAGRAM_HOSTS.has(host)) return "INSTAGRAM";
  if (YOUTUBE_HOSTS.has(host)) return "YOUTUBE";
  return "UNSUPPORTED";
}

// 유튜브 video id — 표준은 11자지만 방어적으로 6~20자 허용(스펙 확정)
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * 유튜브 URL에서 video id를 파싱해 무비용 썸네일 URL을 파생한다.
 * 지원 형태: watch?v={id} / youtu.be/{id} / shorts/{id} / embed/{id}.
 * id 검증 실패·형태 불일치(채널·재생목록 URL 등)는 null.
 */
export function deriveYoutubeThumbnailUrl(url: string): string | null {
  if (classifyReferenceUrl(url) !== "YOUTUBE") return null;
  const parsed = new URL(url); // classify 통과 → 파싱 보장
  const segments = parsed.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (parsed.hostname.toLowerCase() === "youtu.be") {
    id = segments[0] ?? null;
  } else if (segments[0] === "watch") {
    id = parsed.searchParams.get("v");
  } else if (segments[0] === "shorts" || segments[0] === "embed") {
    id = segments[1] ?? null;
  }
  if (!id || !YOUTUBE_ID_PATTERN.test(id)) return null;
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}

export type InstagramPostMeta = {
  caption: string | null;
  thumbnailUrl: string | null;
  likes: number | null;
  /** 릴스 동영상 URL — /embed 파싱 경로(fetchInstagramPostMeta)만 제공(Apify 매퍼는 미지원). */
  videoUrl?: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Apify instagram-scraper(resultsType:"posts") 아이템 1건을 메타로 매핑한다.
 * scrapeTier1(scraper.ts)의 관용 dual-field 스타일 그대로 — 액터/버전에 따라 필드 위치가
 * 다른 두 형상(Graph 스타일 caption.text/media.display_uri/engagement.like_count vs
 * instagram-scraper의 평면 caption/displayUrl/likesCount)을 모두 수용한다. 후자는 실호출로
 * 검증(2026-07-08). unknown 입력을 안전하게 좁혀 처리(any 금지).
 */
export function mapApifyPostItem(item: unknown): InstagramPostMeta {
  const rec = asRecord(item);
  if (!rec) return { caption: null, thumbnailUrl: null, likes: null };

  // caption: item.caption?.text || item.caption
  const captionObj = asRecord(rec.caption);
  const caption = asNonEmptyString(captionObj?.text) ?? asNonEmptyString(rec.caption);

  // thumbnailUrl: item.media?.display_uri || item.displayUrl || item.images?.[0]
  const media = asRecord(rec.media);
  const images: unknown[] = Array.isArray(rec.images) ? rec.images : [];
  const thumbnailUrl =
    asNonEmptyString(media?.display_uri) ??
    asNonEmptyString(rec.displayUrl) ??
    asNonEmptyString(images[0]);

  // likes: item.engagement?.like_count ?? item.likesCount — 0 보존(?? 체인)
  const engagement = asRecord(rec.engagement);
  const likes = asFiniteNumber(engagement?.like_count) ?? asFiniteNumber(rec.likesCount);

  return { caption, thumbnailUrl, likes };
}

export type InstagramProfileMeta = {
  username: string | null;
  fullName: string | null;
  bio: string | null;
  followerCount: number | null;
  postCount: number | null;
  profilePicUrl: string | null;
};

/**
 * RapidAPI instagram-scraper-20251 /userinfo 응답 1건을 프로필 메타로 매핑한다.
 * scraper.ts(Tier1/Tier2)에서 실증된 관용 unwrap을 그대로 따른다:
 * 배열([{...}]) → username 있는 첫 요소, 객체 → data 래핑 또는 평면.
 * 프로필 사진은 hd_profile_pic_url_info.url 우선, 없으면 profile_pic_url.
 */
export function mapRapidApiUserInfo(raw: unknown): InstagramProfileMeta {
  const candidate = Array.isArray(raw)
    ? raw.find((x) => asRecord(x)?.username) ?? raw[0]
    : raw;
  const outer = asRecord(candidate);
  const rec = asRecord(outer?.data) ?? outer;

  const hd = asRecord(rec?.hd_profile_pic_url_info);
  return {
    username: asNonEmptyString(rec?.username),
    fullName: asNonEmptyString(rec?.full_name),
    bio: asNonEmptyString(rec?.biography),
    followerCount: asFiniteNumber(rec?.follower_count),
    postCount: asFiniteNumber(rec?.media_count),
    profilePicUrl: asNonEmptyString(hd?.url) ?? asNonEmptyString(rec?.profile_pic_url),
  };
}

export const AUTO_NOTE_PREFIX = "[자동수집] ";
const AUTO_NOTE_CAPTION_MAX = 500;

/**
 * 인스타 캡션으로 자동 메모를 만든다: "[자동수집] {캡션 500자 truncate}" (+ 좋아요 수).
 * 호출부는 Asset.notes가 비어있을 때만 저장한다(사용자 메모 덮어쓰기 금지 — 스펙 확정).
 */
export function buildAutoNote(caption: string, likes: number | null): string {
  const truncated = caption.trim().slice(0, AUTO_NOTE_CAPTION_MAX);
  const likesSuffix = likes !== null ? ` · 좋아요 ${likes}` : "";
  return `${AUTO_NOTE_PREFIX}${truncated}${likesSuffix}`;
}
