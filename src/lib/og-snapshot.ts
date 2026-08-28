/**
 * 목적지 페이지의 공유 미리보기(OG) 스냅샷.
 *
 * 발급 시점에 한 번 긁어 `TrackedLink` 에 저장해 두면, go.ygrd.kr 리다이렉터가 매 요청에서
 * 이미 하는 링크 조회에 얹혀 와 **미리보기에 드는 추가 왕복이 0회**가 된다.
 *
 * 이 파일은 순수 파싱과 대상 판정, 그리고 수집 fetch 까지만 담는다 — 호출은 라우트의
 * `after()` 가 소유한다(도메인 서비스에 외부 IO 를 넣지 않는다, 실사고 2026-07-30).
 */

export type OgSnapshot = {
  title: string | null;
  image: string | null;
  description: string | null;
};

const META_TAG = /<meta\s+[^>]*>/gi;

/** OG 는 head 에 있다 — 긴 본문까지 정규식으로 훑지 않는다. */
const HEAD_SCAN_LIMIT = 100_000;

function readAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/** 미리보기 문구에 `&amp;` 가 글자 그대로 노출되지 않게 기본 엔티티만 되돌린다. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseOgTags(html: string): OgSnapshot {
  const head = html.slice(0, HEAD_SCAN_LIMIT);
  const out: OgSnapshot = { title: null, image: null, description: null };

  for (const tag of head.match(META_TAG) ?? []) {
    // 국내 쇼핑몰 상당수가 property 대신 name 을 쓴다 — 둘 다 본다.
    const key = (readAttr(tag, "property") ?? readAttr(tag, "name") ?? "").toLowerCase();
    const content = readAttr(tag, "content");
    if (!content) continue;
    if (key === "og:title" && !out.title) out.title = decodeEntities(content);
    else if (key === "og:image" && !out.image) out.image = decodeEntities(content);
    else if (key === "og:description" && !out.description) out.description = decodeEntities(content);
  }

  if (!out.title) {
    const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = titleTag ? decodeEntities(titleTag[1]).trim() : "";
    out.title = text || null;
  }

  return out;
}

/**
 * 이 URL 을 서버가 직접 열어봐도 되는가.
 *
 * ⚠️ 이 fetch 는 **프로덕션 호스트에서** 실행되고 대상은 운영자가 입력한 값이다.
 * 그 기계에는 자체호스팅 Supabase 가 `127.0.0.1` 로 떠 있으므로, 가드가 없으면 내부
 * 주소를 대신 열어보는 통로가 된다(SSRF).
 */
export function isFetchableDestination(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    // 172 는 16~31 만 사설이다 — 대역을 대충 잡으면 정상 목적지를 막는다.
    if (a === 172 && b >= 16 && b <= 31) return false;
  }

  return true;
}

/** 목적지가 느릴 때 발급 응답 뒤 훅이 오래 매달리지 않게 한다. */
const FETCH_TIMEOUT_MS = 5_000;
/** 본문이 커도 OG 는 앞쪽 head 에 있다. */
const MAX_HTML_BYTES = 512 * 1024;

/**
 * 리다이렉트 추적 상한. 홉마다 목적지를 다시 판정하므로 무한 루프도 여기서 끊긴다.
 */
const MAX_REDIRECT_HOPS = 3;

async function fetchOnce(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      // ⚠️ `follow` 를 쓰면 안 된다 — 첫 홉만 검사한 뒤 302 로 내부망에 착지할 수 있다.
      // 직접 따라가면서 홉마다 isFetchableDestination 을 다시 건다.
      redirect: "manual",
      headers: {
        // 상대 서버 로그에서 우리를 식별할 수 있게 한다(차단당하면 원인이 보인다).
        "User-Agent": "wag-crm-link-preview/1.0 (+https://ygrd.kr)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 목적지를 열어 OG 스냅샷을 만든다. **예외를 던지지 않는다** — 수집 실패가 링크 발급을
 * 막으면 본말전도다. 건질 게 없으면 `null` 을 돌려주고, 호출부는 저장하지 않는다(빈
 * 스냅샷을 저장하면 `ogFetchedAt` 만 찍혀 리다이렉터의 폴백 수집까지 막힌다).
 *
 * ⚠️ **남는 위험(의도적으로 받아들인다):** DNS 리바인딩 — 공개 도메인이 사설 IP 로
 * 해석되는 경우는 이 판정으로 못 막는다. 완전히 닫으려면 해석 후 IP 고정(resolve-then-pin)
 * 이 필요한데, 대상 URL 을 넣는 주체가 인증된 오너 한 명뿐이라 그 복잡도를 지지 않는다.
 * 이 함수가 막는 것은 **오타·잘못 붙여넣은 내부 주소와 리다이렉트 착지**다.
 */
export async function collectOgSnapshot(targetUrl: string): Promise<OgSnapshot | null> {
  let current = targetUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (!isFetchableDestination(current)) return null;

    const res = await fetchOnce(current);
    if (!res) return null;

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      try {
        // 상대 Location 도 있으므로 현재 URL 기준으로 절대화한다.
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }

    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("html")) return null;

    const html = (await res.text().catch(() => "")).slice(0, MAX_HTML_BYTES);
    const snapshot = parseOgTags(html);
    return snapshot.title || snapshot.image || snapshot.description ? snapshot : null;
  }

  return null;
}
