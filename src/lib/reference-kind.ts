// reference-kind — 미분류 레퍼런스 URL의 콘텐츠 유형 판별과 카드 표기 포맷(순수 함수).
// 인박스 카드(클라이언트)와 enrich-inbox 크론(서버)이 같은 판별을 공유한다.
// 유형은 컬럼으로 저장하지 않고 normalizedUrl에서 결정론적으로 파생한다(드리프트 방지).

export type InstagramRefKind = "POST" | "PROFILE" | "PROFILE_REELS";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

// 게시물 permalink의 첫 세그먼트(p/reel/reels/tv + shortcode).
const POST_SEGMENTS = new Set(["p", "reel", "reels", "tv"]);

// 계정명이 될 수 없는 예약 경로 — 프로필 오판을 막는다.
const RESERVED_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "about",
  "developer",
  "legal",
  "web",
  "graphql",
  "api",
]);

// 인스타 계정명: 영숫자·마침표·언더스코어 1~30자.
const USERNAME_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;
const SHORTCODE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 인스타그램 URL을 콘텐츠 유형으로 분류한다.
 * - POST: /p/{code}, /reel/{code}, /reels/{code}, /tv/{code} (게시물·릴스 단건)
 * - PROFILE: /{username} (+ /tagged, /saved 같은 계정 하위 탭)
 * - PROFILE_REELS: /{username}/reels (계정의 릴스 피드 탭)
 * - null: 비인스타 호스트·예약 경로·판별 불가(스토리 하이라이트 등)
 */
export function classifyInstagramUrl(url: string): InstagramRefKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!INSTAGRAM_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0];
  const second = segments[1];

  if (POST_SEGMENTS.has(first)) {
    return second && SHORTCODE_PATTERN.test(second) ? "POST" : null;
  }
  if (RESERVED_SEGMENTS.has(first.toLowerCase())) return null;
  if (!USERNAME_PATTERN.test(first)) return null;

  if (segments.length === 1) return "PROFILE";
  if (segments.length === 2) {
    const tab = second.toLowerCase();
    if (tab === "reels") return "PROFILE_REELS";
    if (tab === "tagged" || tab === "saved") return "PROFILE";
  }
  return null;
}

/** PROFILE/PROFILE_REELS URL에서 계정명을 추출한다. 그 외 유형은 null. */
export function extractInstagramUsername(url: string): string | null {
  const kind = classifyInstagramUrl(url);
  if (kind !== "PROFILE" && kind !== "PROFILE_REELS") return null;
  return new URL(url).pathname.split("/").filter(Boolean)[0] ?? null;
}

/**
 * 팔로워 등 수치의 한국식 축약 표기.
 * 1만 이상은 "N.N만"(소수 첫째 자리, 트레일링 0 제거, 100만 이상은 정수),
 * 미만은 천단위 구분자 원수 그대로.
 */
export function formatKoreanCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 10_000) {
    const man = value / 10_000;
    const rounded = man >= 100 ? Math.round(man) : Math.round(man * 10) / 10;
    return `${rounded}만`;
  }
  return Math.floor(value).toLocaleString("ko-KR");
}

/**
 * 수집 시점의 상대 표기: 방금 전 / N분 전 / N시간 전 / N일 전 / N개월 전 / N년 전.
 * 미래 시각·파싱 불가 입력은 각각 "방금 전"/""로 방어한다.
 */
export function formatRelativeKo(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMinutes = Math.floor((now.getTime() - t) / 60_000);
  if (diffMinutes < 1) return "방금 전";
  if (diffMinutes < 60) return `${diffMinutes}분 전`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  return `${Math.floor(months / 12)}년 전`;
}
