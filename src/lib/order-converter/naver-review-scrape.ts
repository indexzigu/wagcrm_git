import type { BrowserContext, Page } from 'playwright-core';
import type { VocReview } from './voc-store';

/**
 * 스마트스토어 공개 상품페이지 리뷰 수집 — Phase 2b. SSOT: REVIEW_QNA_COLLECTION_PLAN.md §2-B-실측.
 *
 * 리뷰는 공식 API가 없다(§1) — 공개 페이지의 비공개 XHR이 유일 경로다. 순수 fetch는 UA·Referer를
 * 줘도 **429**(실측)라 브라우저 컨텍스트(쿠키)가 필수. 다만 스토리 뷰어와 달리 **서명은 불필요**해서,
 * 상품페이지를 1회 로드해 컨텍스트만 얻은 뒤 `page.evaluate(fetch)`로 API를 페이지네이션한다
 * (DOM 조작·리로드 없음 = 가볍고 마크업 변경에 덜 취약).
 *
 * 계약(2026-07-17 실측, 비공개 인터페이스라 변경될 수 있음 — 깨지면 status=ERROR 강등 후 재실측):
 *  - 집계: GET  /i/v1/contents/reviews/product-summary/{originProductNo}?checkoutMerchantNo=..
 *  - 목록: POST /i/v1/contents/reviews/query-pages
 *          {checkoutMerchantNo, originProductNo, page, pageSize, reviewSearchSortType}
 *  - 키는 **originProductNo**(원상품번호) — QnA(채널번호)와 반대라 OrderCampaign.productId 직결.
 *
 * ⚠️ PII(D4): 응답의 writerId·writerMemberNo·writerIdNo·orderNo·productOrderNo는 **저장 금지**.
 *    parseReviewItem이 화이트리스트로만 취한다.
 *
 * 🔴 안티봇(실측 2026-07-18): 반복 접근 시 네이버가 **CAPTCHA("보안 확인")로 차단**한다. 순수
 *    fetch는 즉시 429, 브라우저도 로컬 IP가 반복 후 플래그됨. CAPTCHA는 우회하지 않는다(정책) —
 *    페이지 텍스트에 "보안 확인"이 잡히면 이 실행을 실패로 처리하고 소스 status=ERROR 강등한다.
 *    prod(Vercel/러너 IP) 작동 여부가 진짜 게이트다. 차단 지속 시: ① 프록시 경유 Playwright
 *    (기존 PROXY_URLS/FIXIE — proxyFetch가 쓰는 것, launch 옵션 proxy로 주입) ② 로컬 러너 폴백.
 *    수집 빈도를 낮게(딜당 일 1회, 라운드로빈) 유지하는 것도 플래그 완화책.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** 상품당 페이지 상한(안전) — pageSize 20 × 25 = 최대 500건/딜. 계획 캡(300)보다 크지만 코퍼스는 dedup 병합. */
export const REVIEW_MAX_PAGES = 25;
export const REVIEW_PAGE_SIZE = 20;

// ─────────────────────────── 순수 파서(테스트 대상 — 네트워크 비의존) ───────────────────────────

/** 자사 스마트스토어 공개 상품 URL. 슬러그는 스토어 정체성(공개값) — 브랜드몰은 각자 productUrl을 갖는다. */
export const SELF_STORE_SLUG = 'ygrd';

export function buildSmartstoreProductUrl(channelProductNo: string, slug: string = SELF_STORE_SLUG): string {
  return `https://smartstore.naver.com/${slug}/products/${channelProductNo}`;
}

/** 스마트스토어 상품 URL에서 channelProductNo를 뽑는다(순수). 단축링크 해석 결과 URL 파싱용. */
export function extractChannelNoFromProductUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /smartstore\.naver\.com\/[^/]+\/products\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * query-pages 응답 item → VocReview. **PII 화이트리스트**(D4): maskedWriterId만 취하고
 * writerId·writerMemberNo·writerIdNo·orderNo·productOrderNo는 의도적으로 버린다.
 * 필수 결측(id·평점·본문·작성일)이면 null(스킵).
 */
export function parseReviewItem(raw: unknown): VocReview | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = r.id != null ? String(r.id).trim() : '';
  if (!id) return null;

  const rating = Math.round(Number(r.reviewScore));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;

  const content = typeof r.reviewContent === 'string' ? r.reviewContent.trim() : '';
  if (content.length === 0) return null; // 포토 전용(본문 없음) 리뷰는 요약 가치가 없어 스킵

  const wt = r.createDate != null ? new Date(String(r.createDate)) : null;
  if (!wt || Number.isNaN(wt.getTime())) return null;

  // reviewAttaches: [{ ... imageUrl/thumbnailUrl ... }] — URL 문자열만 추출(원본 blob 미저장).
  const imageUrls: string[] = [];
  if (Array.isArray(r.reviewAttaches)) {
    for (const a of r.reviewAttaches) {
      if (!a || typeof a !== 'object') continue;
      const at = a as Record<string, unknown>;
      const u = at.imageUrl ?? at.thumbnailImageUrl ?? at.originalImageUrl ?? at.url;
      if (typeof u === 'string' && u.length > 0) imageUrls.push(u);
    }
  }

  return {
    externalId: `naver:${id}`, // 소스 접두 — 수동 임포트 해시 id와 충돌 방지
    rating,
    content,
    writtenAt: wt.toISOString(),
    writerMasked: typeof r.maskedWriterId === 'string' ? r.maskedWriterId : null,
    optionText: typeof r.productOptionContent === 'string' ? r.productOptionContent : null,
    isRepurchase: typeof r.repurchase === 'boolean' ? r.repurchase : null,
    imageUrls,
    helpCount: null, // 공개 응답에 도움수 필드 없음(실측) — 계획서 기대와 다른 점
  };
}

export type ReviewSummaryStat = {
  reviewCount: number;
  averageScore: number | null;
  photoReviewCount: number;
};

/** product-summary 응답 → 집계(스토어가 계산해 주는 값 — 우리가 다시 셀 필요 없음). */
export function parseReviewSummary(raw: unknown): ReviewSummaryStat | null {
  if (!raw || typeof raw !== 'object') return null;
  const info = (raw as Record<string, unknown>).productReviewInfo;
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const count = Number(i.reviewCount);
  if (!Number.isFinite(count)) return null;
  const avg = Number(i.averageReviewScore);
  return {
    reviewCount: count,
    averageScore: Number.isFinite(avg) ? avg : null,
    photoReviewCount: Number.isFinite(Number(i.photoReviewCount)) ? Number(i.photoReviewCount) : 0,
  };
}

// ─────────────────────────── 브라우저 I/O ───────────────────────────

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV);
}

export type PlaywrightProxy = { server: string; username?: string; password?: string };

/**
 * 프록시 URL(http://user:pass@host:port) → Playwright proxy 옵션으로 파싱한다(순수).
 * fetch-client의 proxyFetch와 **같은 env**(PROXY_URLS/FIXIE)를 읽되 포맷만 변환한다. 목적은
 * 봇 탐지 **회피가 아니라** 깨끗한 IP로의 정상 라우팅 — CAPTCHA가 애초에 안 뜨게 하는 것이다
 * (이미 뜬 CAPTCHA를 뚫는 것이 아님, §2-B-실측). 미설정/파싱불가면 null(직결 폴백).
 */
export function parseProxyForPlaywright(raw: string | null | undefined): PlaywrightProxy | null {
  if (!raw) return null;
  const first = raw.split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  try {
    const u = new URL(first);
    const proxy: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return null;
  }
}

/** 환경에서 프록시 옵션을 구성한다(있으면). proxyFetch와 동일 env 순서. */
function proxyFromEnv(): PlaywrightProxy | null {
  return parseProxyForPlaywright(
    process.env.PROXY_URLS || process.env.FIXIE_URLS || process.env.FIXIE_URL,
  );
}

const CONTEXT_OPTS = {
  headless: true,
  userAgent: UA,
  viewport: { width: 1280, height: 1000 },
  locale: 'ko-KR',
} as const;

/**
 * 리뷰 수집용 브라우저 컨텍스트 — **default(persistent) 컨텍스트**를 반환한다.
 *
 * ⚠️ story-viewer-fetch.ts와 동일한 제약(그 파일이 이 패턴의 근거): @sparticuz headless_shell은
 * `--single-process`라 `browser.newContext()`가 브라우저를 즉사시킨다(프로덕션 실사고 PR#113).
 * **newContext() 재도입 금지.** Chromium 메이저 정합 계약(story-browser-version.contract.test.ts)이
 * playwright-core ↔ @sparticuz 버전을 기계 강제한다 — 이 모듈도 같은 바이너리를 쓴다.
 * 프로필 경로는 스토리와 분리(동시 실행 시 잠금 충돌 방지).
 */
export async function launchReviewContext(): Promise<BrowserContext> {
  // 깨끗한 IP 라우팅(설정 시) — 봇 탐지 트리거 완화용. CAPTCHA 우회 아님(§2-B-실측).
  const proxy = proxyFromEnv();
  if (isServerless()) {
    const { chromium } = await import('playwright-core');
    const sparticuz = (await import('@sparticuz/chromium')).default;
    sparticuz.setGraphicsMode = false; // XHR만 쓰므로 WebGL 불요 — Lambda 메모리·크래시 리스크 감소
    return chromium.launchPersistentContext('/tmp/review-scrape-profile', {
      ...CONTEXT_OPTS,
      ...(proxy ? { proxy } : {}),
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
    });
  }
  const { chromium } = await import('playwright-core');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return chromium.launchPersistentContext(join(tmpdir(), 'wag-review-scrape-profile'), {
    ...CONTEXT_OPTS,
    ...(proxy ? { proxy } : {}),
  });
}

/**
 * 딜의 캠페인 단축링크를 브라우저로 열어 최종 상품페이지의 channelProductNo를 해석한다(Phase 2b
 * 링크 매칭). 단축링크는 JS 리다이렉트라 HTTP 클라이언트로는 못 푼다(실측). 리다이렉트가
 * smartstore 상품 URL에 정착하면 URL에서 채널번호를 뽑는다. 로그인 벽/차단이면 null(호출부가 캐시).
 */
export async function resolveShortLinkChannelNo(page: Page, shortLink: string): Promise<string | null> {
  await page.goto(shortLink, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page
    .waitForURL(/smartstore\.naver\.com\/[^/]+\/products\/\d+/, { timeout: 12_000 })
    .catch(() => undefined);
  return extractChannelNoFromProductUrl(page.url());
}

export type ScrapedReviews = {
  reviews: VocReview[];
  summary: ReviewSummaryStat | null;
  totalElements: number;
  merchantNo: string; // 이 스크랩에 쓴 checkoutMerchantNo — 같은 스토어 다음 딜에 hint로 재사용(대기 절약)
};

/**
 * 상품 1개의 리뷰를 수집한다. 페이지를 1회 로드해 컨텍스트(쿠키)와 checkoutMerchantNo를 얻은 뒤,
 * 페이지 안에서 query-pages를 페이지네이션한다. 실패는 throw(호출부가 소스 status=ERROR 강등).
 *
 * @param merchantNoHint 이미 아는 checkoutMerchantNo(있으면 페이지 가로채기를 기다리지 않음)
 */
export async function scrapeProductReviews(
  page: Page,
  input: { productUrl: string; originProductNo: string; merchantNoHint?: string | null },
): Promise<ScrapedReviews> {
  let merchantNo: string | null = input.merchantNoHint ?? null;

  // page.evaluate(fetch)가 smartstore 오리진에서 돌아야 상대경로 API가 먹는다 — 항상 goto한다.
  // merchantNo hint가 없을 때만, 상품페이지가 자기 XHR에 싣는 checkoutMerchantNo를 가로챈다
  // (하드코딩 금지 — 몰마다 다름). hint가 있으면(같은 스토어 2번째 딜~) 가로채기·대기를 생략.
  const onRequest = (req: { url: () => string }) => {
    if (merchantNo) return;
    const m = /[?&]checkoutMerchantNo=(\d+)/.exec(req.url());
    if (m) merchantNo = m[1];
  };
  if (!merchantNo) page.on('request', onRequest);

  let finalUrl = '';
  let bodyHead = '';
  try {
    await page.goto(input.productUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    // 진입이 단축링크(mkt.shopping)면 JS 리다이렉트로 상품페이지에 도착한다 — page.evaluate(fetch)가
    // 상대경로라 **스마트스토어 오리진**이 되어야 먹는다. 상품 URL 패턴이 될 때까지 대기(직접 URL이면
    // 즉시 통과, 로그인 벽이면 타임아웃 후 아래 감지에 걸림).
    await page
      .waitForURL(/smartstore\.naver\.com\/[^/]+\/products\//, { timeout: 15_000 })
      .catch(() => undefined);
    // 리뷰 위젯(checkoutMerchantNo를 싣는 XHR)은 **스크롤 지연 로드**다(실측 — prod 첫 실행이
    // 스크롤 없이 merchantNo 미확보로 실패). hint가 없으면 아래로 스크롤해 위젯을 트리거한다.
    if (!merchantNo) {
      for (let i = 0; i < 12 && !merchantNo; i++) {
        await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => undefined);
        await page.waitForTimeout(700);
      }
      // XHR로 못 잡았으면 렌더된 HTML/인라인 스크립트에서 직접 추출(폴백 — 위젯 미발화 대비).
      if (!merchantNo) {
        merchantNo = await page
          .evaluate(() => {
            const m = /checkoutMerchantNo["':\s]{1,6}(\d{6,})/.exec(document.documentElement.innerHTML);
            return m ? m[1] : null;
          })
          .catch(() => null);
      }
    }
    finalUrl = page.url();
    bodyHead = await page.evaluate(() => (document.body?.innerText || '').slice(0, 140)).catch(() => '');
  } finally {
    page.off('request', onRequest);
  }

  // 봇 차단(CAPTCHA "보안 확인") 또는 로그인 리다이렉트 감지 — 차단 페이지를 정상으로 오인해
  // 빈 코퍼스를 저장하지 않게 명확히 실패시킨다(침묵 실패 금지 P0). CAPTCHA는 우회하지 않는다.
  if (/보안 확인|자동입력 방지|captcha/i.test(bodyHead) || /nidlogin|nid\.naver\.com/.test(finalUrl)) {
    throw new Error(`네이버 차단/로그인 감지: 리뷰 수집 불가(url=${finalUrl.slice(0, 60)}). prod/프록시 IP 필요(§2-B-실측).`);
  }

  if (!merchantNo) {
    // 진단 포함(다음 실행이 원인을 특정하도록) — 페이지 chrome 텍스트라 PII 아님.
    throw new Error(
      `checkoutMerchantNo 미확보: 페이지 구조 변경/차단 가능(url=${finalUrl.slice(0, 60)} · "${bodyHead.replace(/\s+/g, ' ').slice(0, 70)}").`,
    );
  }

  const result = await page.evaluate(
    async (args: { originNo: string; merchant: string; pageSize: number; maxPages: number }) => {
      const call = async (p: number) => {
        const res = await fetch('/i/v1/contents/reviews/query-pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            checkoutMerchantNo: Number(args.merchant),
            originProductNo: Number(args.originNo),
            page: p,
            pageSize: args.pageSize,
            reviewSearchSortType: 'REVIEW_RANKING',
          }),
        });
        if (!res.ok) throw new Error(`query-pages ${p}p HTTP ${res.status}`);
        return (await res.json()) as { contents?: unknown[]; totalElements?: number; totalPages?: number };
      };

      const first = await call(1);
      const total = Number(first.totalElements) || 0;
      const items: unknown[] = Array.isArray(first.contents) ? [...first.contents] : [];
      // 순회 페이지 수는 총건수에서 계산(테스트된 계약) — 서버 totalPages와 min으로 이중 방어.
      const byCount = Math.ceil(total / args.pageSize);
      const totalPages = Math.min(byCount, Number(first.totalPages) || byCount, args.maxPages);
      for (let p = 2; p <= totalPages; p++) {
        const next = await call(p);
        if (Array.isArray(next.contents)) items.push(...next.contents);
      }

      // 집계는 스토어가 계산해 준 값을 그대로 가져온다(우리가 다시 셀 필요 없음)
      let summaryRaw: unknown = null;
      try {
        const s = await fetch(
          `/i/v1/contents/reviews/product-summary/${args.originNo}?checkoutMerchantNo=${args.merchant}`,
          { headers: { Accept: 'application/json' } },
        );
        if (s.ok) summaryRaw = await s.json();
      } catch {
        /* 집계는 보조 — 실패해도 목록으로 진행 */
      }

      return { items, total, summaryRaw };
    },
    {
      originNo: input.originProductNo,
      merchant: merchantNo,
      pageSize: REVIEW_PAGE_SIZE,
      maxPages: REVIEW_MAX_PAGES,
    },
  );

  const reviews: VocReview[] = [];
  for (const raw of result.items) {
    const parsed = parseReviewItem(raw);
    if (parsed) reviews.push(parsed);
  }

  return {
    reviews,
    summary: parseReviewSummary(result.summaryRaw),
    totalElements: result.total,
    merchantNo,
  };
}
