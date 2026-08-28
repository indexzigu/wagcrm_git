/**
 * ygrd-link — 공구 유입추적 리다이렉터 (Cloudflare Worker)
 *
 * go.ygrd.kr/{code} 로 들어온 클릭을 기록한 뒤 브랜드사 원본 링크로 302 시킨다.
 * wag-crm(Vercel) 은 이 경로에 전혀 관여하지 않는다 — 읽기만 한다.
 *
 * 흐름:
 *   1. code 로 TrackedLink 조회 (Cache API 로 5분 캐시 → 대부분 DB 왕복 0회)
 *   2. 302 Location 즉시 반환
 *   3. ctx.waitUntil() 으로 LinkClick 적재 (리다이렉트 지연 0ms)
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** visitorHash 용 pepper. 절대 로그/응답에 노출하지 않는다. */
  HASH_SALT: string;
  /** code 미존재/만료 시 보낼 곳 */
  FALLBACK_URL: string;
  /** 링크 조회 캐시 TTL(초). 미설정 시 300 */
  LINK_CACHE_TTL?: string;
  /** 스냅샷을 신선하다고 볼 시간(시간 단위). 미설정 시 24 */
  OG_SNAPSHOT_MAX_AGE_HOURS?: string;
}

type TrackedLink = {
  id: string;
  code: string;
  targetUrl: string;
  isActive: boolean;
  expiresAt: string | null;
  // 최소 컬럼 재조회 경로에서는 아예 없을 수 있다(위 MINIMAL_LOOKUP_COLUMNS 참고) —
  // 그래서 optional 이다. 없으면 스냅샷이 없는 것으로 보고 느린 길로 간다.
  ogTitle?: string | null;
  ogImage?: string | null;
  ogDescription?: string | null;
  ogFetchedAt?: string | null;
};

const LOOKUP_COLUMNS =
  'id,code,targetUrl,isActive,expiresAt,ogTitle,ogImage,ogDescription,ogFetchedAt';

/**
 * 스냅샷 컬럼을 뺀 최소 집합 — 리다이렉트에 반드시 필요한 것만.
 *
 * `lookupLink` 가 위 조회에 실패했을 때 한 번 더 물어보는 데 쓴다. 스냅샷 컬럼은 이
 * Worker 와 **다른 레인**(CRM 마이그레이션)으로 배포되므로 둘 사이에 컬럼이 없는 창이
 * 생길 수 있고, 그때 조회가 통째로 실패하면 링크 전체가 죽는다.
 */
const MINIMAL_LOOKUP_COLUMNS = 'id,code,targetUrl,isActive,expiresAt';

/**
 * 링크 미리보기 크롤러 — 사람의 클릭이 아니므로 isBot=true 로 분리 집계한다.
 *
 * `bot` 을 단어 경계 없이 잡는 것은 **의도**다. 크롤러는 스스로를 `Googlebot`·
 * `AhrefsBot` 처럼 접미사로 부르므로 경계를 걸면 오히려 놓친다. 대가로 UA 에 bot 이
 * 부분 문자열로 든 실기기(예: CUBOT 계열 안드로이드 단말)가 봇으로 분류될 수 있다 —
 * 그 클릭은 유실이 아니라 `isBot=true` 로 **보존**되고 기본 집계에서만 빠진다
 * (`includeBots=1` 로 다시 볼 수 있다). 국내 공구 트래픽에서 그 단말 비중보다
 * 카톡·메타 미리보기 크롤러를 놓치는 쪽의 손해가 훨씬 크다는 판단이다.
 */
const BOT_UA =
  /bot|crawler|spider|crawling|facebookexternalhit|kakaotalk-scrap|kakaostory-og-reader|twitterbot|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|embedly|quora link preview|pinterest|yeti|daumoa|google-inspectiontool|headlesschrome|lighthouse|curl\/|wget\/|python-requests|node-fetch|axios/i;

/**
 * 이 요청을 사람이 아닌 것으로 볼 것인가.
 *
 * **클릭 라벨(`isBot`)과 미리보기 분기가 이 함수 하나를 공유한다.** 종전에는 적재 쪽만
 * `|| !ua`(UA 없음도 봇)를 갖고 있어, UA 가 빈 요청이 집계에서는 봇인데 화면에서는
 * 사람 취급을 받았다 — 판정이 두 벌이면 이렇게 조용히 갈린다.
 */
function isBotRequest(ua: string): boolean {
  return BOT_UA.test(ua) || !ua;
}

/** 한국 유입의 대부분은 인앱 브라우저다 — referer 가 비어도 여기서 출처가 잡힌다. */
const IN_APP: Array<[RegExp, string]> = [
  [/KAKAOTALK/i, 'kakaotalk'],
  [/Instagram/i, 'instagram'],
  [/FBAV|FB_IAB|FBAN/i, 'facebook'],
  [/NAVER\(inapp/i, 'naver'],
  [/DaumApps|DaumDevice/i, 'daum'],
  [/Line\//i, 'line'],
  [/Threads/i, 'threads'],
  [/TikTok|BytedanceWebview|musical_ly/i, 'tiktok'],
  [/Twitter/i, 'x'],
  [/YaBrowser|; wv\)/i, 'webview'],
];

function detectDevice(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobile|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function detectOs(ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

function detectBrowser(ua: string): string {
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  if (/Edg\//i.test(ua)) return 'edge';
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Whale/i.test(ua)) return 'whale';
  if (/Chrome\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  if (/Firefox\//i.test(ua)) return 'firefox';
  return 'unknown';
}

/** referer 호스트를 사람이 읽는 채널명으로. 인앱이면 UA 판정이 우선한다. */
function detectChannel(refererHost: string, browser: string): string {
  const inApp = IN_APP.some(([, name]) => name === browser);
  if (inApp) return browser;
  if (!refererHost) return 'direct';
  if (/instagram\./i.test(refererHost)) return 'instagram';
  if (/kakao|daum\./i.test(refererHost)) return 'kakao';
  if (/naver\./i.test(refererHost)) return 'naver';
  if (/google\./i.test(refererHost)) return 'google';
  if (/facebook\./i.test(refererHost)) return 'facebook';
  if (/youtube\.|youtu\.be/i.test(refererHost)) return 'youtube';
  if (/tiktok\./i.test(refererHost)) return 'tiktok';
  if (/threads\./i.test(refererHost)) return 'threads';
  if (/(^|\.)x\.com$|twitter\./i.test(refererHost)) return 'x';
  return refererHost;
}

/**
 * 원문 IP 는 저장하지 않는다(개인정보보호법 최소수집).
 * salt + ip + ua + 날짜(KST) 를 SHA-256 → 앞 16바이트만 보관 →
 * "같은 사람이 같은 날 다시 눌렀는가"만 판별 가능하고 역추적은 불가하다.
 */
async function visitorHash(salt: string, ip: string, ua: string, kstDate: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${ip}|${ua}|${kstDate}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function kstDateString(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sb(env: Env, path: string): string {
  return `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
}

function sbHeaders(env: Env, extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function lookupLink(code: string, env: Env, ctx: ExecutionContext): Promise<TrackedLink | null> {
  const ttl = Number(env.LINK_CACHE_TTL ?? '300') || 300;
  const cacheKey = new Request(`https://link-cache.ygrd.kr/${encodeURIComponent(code)}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = (await cached.json()) as TrackedLink | null;
    return body && body.code ? body : null;
  }

  const query = (columns: string) =>
    fetch(sb(env, `TrackedLink?code=eq.${encodeURIComponent(code)}&select=${columns}&limit=1`), {
      headers: sbHeaders(env),
    });

  let res = await query(LOOKUP_COLUMNS);
  if (!res.ok) {
    // ⚠️ 이 재시도가 **전면 장애를 막는 장치**다. 스냅샷 컬럼은 이 Worker 와 다른
    // 레인으로 배포되므로(CRM 마이그레이션), Worker 가 먼저 나가면 PostgREST 가
    // 없는 컬럼에 400 을 준다. 그때 그냥 null 을 돌려주면 미리보기뿐 아니라
    // **모든 사람 클릭이 폴백으로 떨어진다** — 링크 전체가 죽는 것과 같다.
    // 최소 컬럼으로 한 번 더 물어 리다이렉트만은 반드시 살린다(미리보기는 포기).
    res = await query(MINIMAL_LOOKUP_COLUMNS);
    if (!res.ok) return null;
  }

  const rows = (await res.json()) as TrackedLink[];
  const link = rows[0] ?? null;

  // 미존재(null)도 캐시한다 — 잘못된 코드 스캔이 DB 를 두드리지 못하게.
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(link), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${link ? ttl : 60}` },
      }),
    ),
  );
  return link;
}

/** 우리 내부용 파라미터 — 목적지로 넘기지 않는다. */
const INTERNAL_PARAMS = new Set(['s', 'code']);

/**
 * 원본 링크의 쿼리는 보존하고, 셀러가 덧붙인 파라미터만 얹는다.
 * 원본에 이미 있는 키는 덮어쓰지 않는다 — 브랜드사 규약이 우선.
 */
function buildTargetUrl(targetUrl: string, incoming: URLSearchParams): string {
  const url = new URL(targetUrl);
  for (const [k, v] of incoming) {
    if (INTERNAL_PARAMS.has(k)) continue;
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function recordClick(
  link: TrackedLink,
  request: Request,
  env: Env,
  now: Date,
  subId: string | null,
): Promise<void> {
  const ua = request.headers.get('user-agent') ?? '';
  const referer = request.headers.get('referer') ?? '';
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf ?? {};

  let refererHost = '';
  try {
    if (referer) refererHost = new URL(referer).hostname;
  } catch {
    /* 잘못된 referer 는 무시 */
  }

  const browser = detectBrowser(ua);
  const row = {
    // Prisma 의 @default(cuid()) 는 앱 레벨 기본값이라 DB 에는 default 가 없다.
    // PostgREST 직접 insert 이므로 id 는 Worker 가 만들어 보낸다.
    id: crypto.randomUUID(),
    trackedLinkId: link.id,
    code: link.code,
    // 같은 셀러의 콘텐츠 구분(?s=story1 / ?s=feed2). 없으면 null.
    subId,
    occurredAt: now.toISOString(),
    visitorHash: await visitorHash(env.HASH_SALT, ip, ua, kstDateString(now)),
    device: detectDevice(ua),
    os: detectOs(ua),
    browser,
    channel: detectChannel(refererHost, browser),
    refererHost: refererHost || null,
    country: (cf.country as string) ?? null,
    city: (cf.city as string) ?? null,
    isBot: isBotRequest(ua),
    userAgent: ua.slice(0, 500) || null,
  };

  await fetch(sb(env, 'LinkClick'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
}

type OgData = { title: string | null; image: string | null; description: string | null };

/**
 * 스냅샷이 없거나 낡았을 때만 쓰는 느린 길. 결과는 Cache API 에만 담는다.
 *
 * ⛔ 여기서 얻은 값을 `TrackedLink` 에 되쓰지 말 것 — 그 테이블의 writer 는 wag-crm
 * 하나다(파일 상단 단일 writer 규약). 그래야 경합이 없다.
 */
async function fetchOgFromDestination(
  code: string,
  destination: string,
  ctx: ExecutionContext,
): Promise<OgData | null> {
  const cacheKey = new Request(`https://og-cache.ygrd.kr/${encodeURIComponent(code)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.json()) as OgData | null;

  let out: OgData | null = null;
  const controller = new AbortController();
  // 목적지가 느리면 크롤러를 잡아두는 만큼 Worker 호출도 물린다. CRM 쪽 쌍둥이
  // (`src/lib/og-snapshot.ts`)와 같은 상한을 건다.
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(destination, {
      signal: controller.signal,
      // 목적지는 우리 DB 의 targetUrl(오너가 입력하고 CRM 이 저장한 값)이고, 이 코드는
      // Cloudflare 엣지에서 돈다 — 우리 사내망으로 가는 경로가 애초에 없다. 그래서
      // CRM 쪽에 있는 사설주소 가드를 여기 복제하지 않는다(복제하면 두 벌이 갈린다).
      redirect: 'follow',
      headers: { 'User-Agent': 'ygrd-link-preview/1.0 (+https://ygrd.kr)', Accept: 'text/html' },
    });
    if (res.ok && (res.headers.get('content-type') ?? '').toLowerCase().includes('html')) {
      const found: OgData = { title: null, image: null, description: null };
      let titleText = '';
      const rewriter = new HTMLRewriter()
        .on('meta', {
          element(el) {
            // 국내 쇼핑몰 상당수가 property 대신 name 을 쓴다 — 둘 다 본다.
            const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase();
            const content = el.getAttribute('content');
            if (!content) return;
            if (key === 'og:title' && !found.title) found.title = content;
            else if (key === 'og:image' && !found.image) found.image = content;
            else if (key === 'og:description' && !found.description) found.description = content;
          },
        })
        .on('title', {
          text(chunk) {
            titleText += chunk.text;
          },
        });
      await rewriter.transform(res).arrayBuffer();
      if (!found.title && titleText.trim()) found.title = titleText.trim();
      if (found.title || found.image || found.description) out = found;
    }
  } catch {
    /* 목적지 장애는 미리보기 포기로 흡수한다 — 호출부가 302 로 떨어진다 */
  } finally {
    clearTimeout(timer);
  }

  // 실패는 짧게만 캐시한다(조회 캐시가 미존재를 60초 담는 것과 같은 관례).
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(out), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${out ? 3600 : 60}`,
        },
      }),
    ),
  );
  return out;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 크롤러에게 줄 최소 HTML.
 *
 * ⚠️ `meta refresh` 와 링크는 장식이 아니다 — `BOT_UA` 는 오탐을 감수한 정규식이라
 * (`CUBOT` 계열 실기기) 사람이 이 응답을 받을 수 있다. 그 사용자가 빈 페이지에 갇히지
 * 않게 즉시 목적지로 보낸다.
 */
function previewResponse(destination: string, og: OgData): Response {
  const title = og.title ?? '공동구매';
  const parts = [
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">',
    `<title>${escapeAttr(title)}</title>`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${escapeAttr(destination)}">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    og.description ? `<meta property="og:description" content="${escapeAttr(og.description)}">` : '',
    og.image ? `<meta property="og:image" content="${escapeAttr(og.image)}">` : '',
    og.image
      ? '<meta name="twitter:card" content="summary_large_image">'
      : '<meta name="twitter:card" content="summary">',
    `<meta http-equiv="refresh" content="0;url=${escapeAttr(destination)}">`,
    '</head><body>',
    `<a href="${escapeAttr(destination)}">${escapeAttr(title)}</a>`,
    '</body></html>',
  ];
  return new Response(parts.join(''), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      // 브라우저가 302 를 캐시하면 두 번째 클릭이 우리 서버를 안 거친다 → 집계 누락.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      // 브랜드사 스토어에 go.ygrd.kr 경로까지 흘리지 않는다.
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // ⚠️ **첫 세그먼트만 코드다 — 뒤에 오는 경로는 의도적으로 무시한다.**
    // CRM 이 메신저 미리보기 캐시를 우회할 때 `/{code}/r{token}` 꼴로 꼬리를
    // 얹어 배포한다(설계: docs/private/specs/2026-08-15-short-link-
    // preview-refresh-design.md). 이 줄이나 buildTargetUrl 을 바꿔 꼬리에
    // 의미를 부여하면 **그 링크들이 전부 조용히 폴백으로 떨어진다** — 운영자는
    // 셀러에게 죽은 링크를 건넨 줄 모른다. CRM 의
    // short-link-preview-refresh.contract.test.ts 가 이 계약을 감시한다.
    const code = url.pathname.replace(/^\/+/, '').split('/')[0];

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!code || code === 'favicon.ico') {
      return redirect(env.FALLBACK_URL);
    }
    if (code === 'robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (code === 'healthz') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) {
      return redirect(env.FALLBACK_URL);
    }

    const now = new Date();
    let link: TrackedLink | null = null;
    try {
      link = await lookupLink(code, env, ctx);
    } catch {
      /* 조회 실패는 폴백으로 흡수 — 셀러 링크가 죽는 것이 최악이다 */
    }

    if (!link || !link.isActive || (link.expiresAt && new Date(link.expiresAt) < now)) {
      return redirect(env.FALLBACK_URL);
    }

    const destination = buildTargetUrl(link.targetUrl, url.searchParams);

    // 크롤러에게는 302 대신 목적지 미리보기를 준다. 판정은 클릭 라벨(isBot)과 같은
    // BOT_UA 하나만 쓴다 — 두 벌이 되면 집계와 화면이 갈린다.
    const ua = request.headers.get('user-agent') ?? '';
    let preview: Response | null = null;
    if (isBotRequest(ua)) {
      const maxAgeHours = Number(env.OG_SNAPSHOT_MAX_AGE_HOURS ?? '24') || 24;
      const fetchedAt = link.ogFetchedAt ? new Date(link.ogFetchedAt).getTime() : 0;
      const fresh = fetchedAt > 0 && now.getTime() - fetchedAt < maxAgeHours * 3600 * 1000;

      let og: OgData | null =
        fresh && (link.ogTitle || link.ogImage)
          ? {
              // 최소 컬럼 재조회 경로에서는 undefined 가 올 수 있다 — null 로 정규화한다.
              title: link.ogTitle ?? null,
              image: link.ogImage ?? null,
              description: link.ogDescription ?? null,
            }
          : null;
      if (!og) og = await fetchOgFromDestination(code, destination, ctx);
      if (og) preview = previewResponse(destination, og);
    }

    // 로그 적재는 응답 이후에 — 사용자는 기다리지 않는다.
    if (request.method === 'GET') {
      const subId = (url.searchParams.get('s') ?? '').slice(0, 64) || null;
      ctx.waitUntil(recordClick(link, request, env, now, subId).catch(() => undefined));
    }

    // 미리보기를 못 만들었으면 지금까지와 똑같이 302 다 — 어떤 실패도 현재보다 나빠지지 않는다.
    return preview ?? redirect(destination);
  },
};
