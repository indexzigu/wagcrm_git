// instagram-embed — 인스타그램 게시물/릴스 링크를 embed.js 카드로 렌더하기 위한 순수 유틸(③b).
// embed.js는 심사·토큰 없이 퍼머링크만으로 표시 전용 카드를 렌더한다(조사보고서 §42 — 약관 리스크 최소).
// 여기서는 "이 URL이 임베드 가능한 IG 퍼머링크인가" 판별과 embed.js가 요구하는 표준 퍼머링크
// 생성만 담당한다(DOM·스크립트 로드는 InstagramEmbed 컴포넌트). 네트워크·DOM 비의존.

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
// 임베드 가능한 콘텐츠 경로: 게시물(p)·릴스(reel)·IGTV(tv). 프로필/스토리는 임베드 불가.
const EMBEDDABLE_PATH = /^\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?/;

/** URL이 임베드 가능한 인스타 게시물/릴스/IGTV 퍼머링크인지 판별한다. */
export function isInstagramPermalink(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!INSTAGRAM_HOSTS.has(parsed.hostname)) return false;
  return EMBEDDABLE_PATH.test(parsed.pathname);
}

/**
 * IG 게시물/릴스/IGTV URL에서 shortcode를 추출한다(p·reel·tv 공통).
 * 포맷 매칭용 — postsPreview는 릴스여도 `/p/{shortcode}/`로 저장되므로 URL 경로가 아니라
 * shortcode로 매칭해야 `/reel/` 수동 URL과도 일치한다. IG가 아니거나 무효면 null.
 */
export function instagramShortcode(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!INSTAGRAM_HOSTS.has(parsed.hostname)) return null;
  const m = parsed.pathname.match(EMBEDDABLE_PATH);
  return m ? m[2] : null;
}

/**
 * embed.js `data-instgrm-permalink`용 표준 퍼머링크를 만든다.
 * https://www.instagram.com/{p|reel|tv}/{shortcode}/ — 쿼리·해시 제거, 후행 슬래시 보장.
 * (쿼리 파라미터/트래킹이 붙으면 embed.js가 카드를 못 그리는 경우가 있어 정규화한다.)
 * 임베드 불가 URL이면 null.
 */
export function toEmbedPermalink(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!INSTAGRAM_HOSTS.has(parsed.hostname)) return null;
  const m = parsed.pathname.match(EMBEDDABLE_PATH);
  if (!m) return null;
  const kind = m[1];
  const shortcode = m[2];
  return `https://www.instagram.com/${kind}/${shortcode}/`;
}
