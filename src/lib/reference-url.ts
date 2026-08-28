// reference-url — 딜 첨부 자료의 외부 레퍼런스 링크(인스타 등) 정규화 순수 함수

import { instagramShortcode } from "./instagram-embed";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

/**
 * 외부 레퍼런스 URL을 정규화한다.
 * - http/https 외 프로토콜(instagram:// 딥링크 등)·파싱 불가 문자열 → null
 * - 인스타그램 호스트는 공유 링크의 트래킹 쿼리(?igsh=…&utm_source=…)와 해시를 제거
 * - 그 외 호스트는 search/hash를 보존(유튜브 `?v=` 등 의미 있는 쿼리 유지)한 채
 *   URL.toString()으로 대소문자·기본포트·인코딩만 정규화
 */
export function normalizeReferenceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    url.search = "";
    url.hash = "";
  }
  // 비-인스타 호스트는 search/hash를 보존한 채(유튜브 ?v= 등) toString으로
  // 대소문자·기본포트·인코딩까지 정규화한다.
  return url.toString();
}

/**
 * 게시물 dedup 신원 키 — 인스타 게시물은 shortcode(`ig:{shortcode}`), 그 외는 정규화 URL.
 * 같은 게시물이 `/p/{sc}/`(수집 프리뷰 관례 — postsPreview는 릴스도 이 형태로 저장)와
 * `/reel/{sc}/`(실제 공유 URL·수동 붙여넣기) 두 형태로 들어와도 하나로 판정한다.
 * 등록(Asset)·무관(SellerPostClassification)·후보(SuggestedPost) 간 대조는 URL 문자열이
 * 아니라 반드시 이 키로 한다 — 문자열 비교는 경로 형태가 갈리면 같은 게시물을 놓친다.
 * 파싱 불가 URL은 null(신원 판정 불가 = 각자 고유 취급은 호출자 몫).
 */
export function postIdentityKey(raw: string): string | null {
  const shortcode = instagramShortcode(raw);
  if (shortcode) return `ig:${shortcode}`;
  return normalizeReferenceUrl(raw);
}

/**
 * URL에서 짧은 표시명을 만든다: 호스트네임(www. 제거) + 경로 앞 2세그먼트.
 * 예: https://www.instagram.com/reel/DEF456/ → instagram.com/reel/DEF456
 * 경로가 없으면 호스트만 반환. 파싱 불가하면 입력을 그대로 반환.
 */
export function deriveLinkName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
  return segments.length > 0 ? `${host}/${segments.join("/")}` : host;
}

/**
 * 콘텐츠 도메인 화이트리스트(R2b) — 카톡 청크에서 자동 유입할 링크의 호스트.
 * 인스타/틱톡/유튜브/네이버 블로그·카페만 통과시키고 배송조회·잡담 링크는 제외한다.
 */
export const CONTENT_DOMAIN_HOSTS: ReadonlySet<string> = new Set([
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com",
  "vt.tiktok.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "blog.naver.com",
  "m.blog.naver.com",
  "cafe.naver.com",
  "m.cafe.naver.com",
]);

/**
 * 정규화된(또는 정규화 가능한) URL의 호스트가 콘텐츠 화이트리스트에 속하는지 판정한다.
 * 파싱 불가·비 http/https는 false.
 */
export function isContentDomain(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return CONTENT_DOMAIN_HOSTS.has(parsed.hostname.toLowerCase());
}

// 카톡 청크 텍스트(`[HH:mm] 발신자: 내용` 개행 결합)에서 http/https URL을 넉넉히 잡는다.
// 공백·개행·한글 등 URL에 올 수 없는 문자 경계에서 종료한다. 후행 문장부호는 아래에서 정리.
const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/g;

/**
 * 청크 텍스트에서 콘텐츠 도메인 URL만 추출한다(순수 함수, R2b).
 *  1) 텍스트에서 http/https URL 정규식 발견
 *  2) 후행 문장부호(. , ! ? 등)를 정리
 *  3) 각 URL을 normalizeReferenceUrl로 정규화(null 제외)
 *  4) isContentDomain 통과분만
 *  5) 결과 내 중복 제거(정규화값 기준, 등장 순서 유지)
 */
export function extractContentUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN);
  if (!matches) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawMatch of matches) {
    // 문장 끝에 붙은 후행 문장부호·닫는 괄호류를 제거(URL 본체 보존).
    const cleaned = rawMatch.replace(/[.,!?;:)\]}'"»…]+$/, "");
    const normalized = normalizeReferenceUrl(cleaned);
    if (normalized === null) continue;
    if (!isContentDomain(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
