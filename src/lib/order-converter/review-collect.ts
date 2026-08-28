import { prisma } from './prisma';
import { pickShortLink } from './review-link';
import { fetchStoreProductNumberPairs, type ProductNumberPair } from './naver-qna-sync';
import { queryOrderDetails } from './naver-order-sync';
import { persistDealReviews, assertDriveReady } from './voc-store';
import {
  launchReviewContext,
  scrapeProductReviews,
  resolveShortLinkChannelNo,
  buildSmartstoreProductUrl,
  parseProxyForPlaywright,
  type ScrapedReviews,
} from './naver-review-scrape';

/**
 * 리뷰 수집 오케스트레이션 — Phase 2b. SSOT: REVIEW_QNA_COLLECTION_PLAN.md §2-B/§2-B-실측.
 *
 * 딜↔상품 매칭 → 공개 상품페이지 스크랩(Playwright) → Drive 코퍼스 병합 저장(persistDealReviews).
 *
 * **링크 매칭(오너 결정 ②, 2026-07-18)**: 수집 후보를 OrderCampaign.productId(주문검증·소수) 외에
 * **딜의 캠페인 단축링크 해석**으로 넓힌다. 단축링크→channelProductNo(브라우저 해석·DealStoreLink
 * 캐시)→origin(스토어 상품쌍). 스토어 리스팅이 소수라 여러 딜이 한 리스팅(묶음)을 공유 → **origin당
 * 스크랩 1회 후 공유 딜들에 같은 리뷰셋 배분**(정직한 공유). 리뷰 API 키는 originProductNo다.
 *
 * 비용·부하 통제(Hobby 60s clamp): 브라우저 1회 기동, 해석·스크랩 각 상한 + 실행 데드라인 배압,
 * 오래된 origin 우선 라운드로빈, 해석 결과 캐시(매 실행 재해석 방지).
 */

export const REVIEW_MAX_ORIGINS_PER_RUN = 4; // 스크랩 상한(origin당 goto+XHR ≈ 8~12s)
export const REVIEW_RECOLLECT_MIN_DAYS = 3; // 이 일수 이내 수집한 origin은 재스크랩 안 함(리뷰 변화 느림) — #42
export const REVIEW_RESOLVE_MAX_PER_RUN = 6; // 해석 상한(Tier-1 주문조회 ≈ 1s · Tier-3 링크 ≈ 3s each)
export const REVIEW_RUN_BUDGET_MS = 50_000;
export const RESOLVE_FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 해석 실패 재시도 TTL

const CHANNEL = 'SMARTSTORE_OWN';

// ─────────────────────────── 순수 로직(테스트 대상) ───────────────────────────

// pickShortLink 정의는 review-link.ts(leaf)로 이전 — 조회·쓰기 경로가 Playwright 의존 없이
// 공유하기 위함. 기존 소비처(테스트 포함) API 보존을 위해 re-export.
export { pickShortLink } from './review-link';

/** 상품 텍스트 정규화(순수) — 대괄호 태그·공백·구분자 제거, 소문자. Tier-2 매칭 키. */
export function normalizeProductText(s: string): string {
  return String(s)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\s/·,()\-]+/g, '')
    .toLowerCase();
}

/**
 * 딜명 ↔ 스토어 리스팅명 결정론 매칭(Tier-2, 순수). 딜명이 **정확히 하나**의 리스팅명에 포함될 때만
 * origin을 반환한다 — 복수 후보=null(오귀속 방지, 매출 오매칭 #33의 교훈). 딜명 2자 미만·이름 없는 pair는 skip.
 */
export function matchDealNameToStoreOrigin(dealName: string, pairs: ProductNumberPair[]): string | null {
  const dn = normalizeProductText(dealName);
  if (dn.length < 2) return null;
  const hits = pairs.filter((p) => p.name && normalizeProductText(p.name).includes(dn));
  return hits.length === 1 ? hits[0].originProductNo : null;
}

/** Json(cachedProductOrderIds 등)을 문자열 배열로 안전 변환(순수). 상한 적용(Tier-1 표본). */
export function toProductOrderIds(json: unknown, cap = 5): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const v of json) {
    const s = v != null ? String(v).trim() : '';
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** 딜당 해석 입력 — 이름(Tier-2)·단축링크(Tier-3)·주문번호(Tier-1). */
export type DealResolveInput = { dealId: string; name: string; shortLink: string | null; productOrderIds: string[] };

/**
 * salesCampaign 행들을 딜당 해석 입력으로 접는다(순수). 딜당 이름(첫 비어있지 않은)·단축링크(첫 유효)·
 * 주문번호(합집합, 상한). 같은 딜의 여러 회차/행을 하나로 병합한다.
 */
export function buildDealResolveInputs(
  rows: { dealId: string; dealName?: string | null; baseNaverLink?: string | null; productOrderIds?: string[] }[],
): DealResolveInput[] {
  const byDeal = new Map<string, DealResolveInput>();
  for (const r of rows) {
    let d = byDeal.get(r.dealId);
    if (!d) {
      d = { dealId: r.dealId, name: '', shortLink: null, productOrderIds: [] };
      byDeal.set(r.dealId, d);
    }
    if (!d.name && r.dealName) d.name = r.dealName;
    if (!d.shortLink) {
      const l = pickShortLink([r.baseNaverLink]);
      if (l) d.shortLink = l;
    }
    if (r.productOrderIds) {
      for (const id of r.productOrderIds) {
        if (id && !d.productOrderIds.includes(id) && d.productOrderIds.length < 5) d.productOrderIds.push(id);
      }
    }
  }
  return Array.from(byDeal.values());
}

/** 스토어 상품쌍 → channel→origin 맵(순수). 해석된 채널번호를 리뷰 API 키(origin)로 되돌린다. */
export function buildChannelToOrigin(
  pairs: { originProductNo: string; channelProductNos: string[] }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of pairs) {
    for (const ch of p.channelProductNos) {
      if (ch && !map.has(ch)) map.set(ch, p.originProductNo);
    }
  }
  return map;
}

export type ResolveCacheRow = { dealId: string; status: string; resolvedAt: Date };

/**
 * 해석이 필요한 딜을 고른다(순수). 캐시에 없거나, FAILED이고 TTL 경과한 것. 상한 적용.
 * 딜당 단축링크는 하나만(첫 개) — 같은 딜의 중복 링크 무시.
 */
export function dealsNeedingResolution<T extends { dealId: string }>(
  inputs: T[],
  cache: Map<string, ResolveCacheRow>,
  now: Date,
  cap = REVIEW_RESOLVE_MAX_PER_RUN,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const dl of inputs) {
    if (seen.has(dl.dealId)) continue;
    seen.add(dl.dealId);
    const c = cache.get(dl.dealId);
    if (!c) {
      out.push(dl);
    } else if (c.status === 'FAILED' && now.getTime() - c.resolvedAt.getTime() > RESOLVE_FAILED_RETRY_MS) {
      out.push(dl);
    }
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * origin → 딜 목록(1:N — 묶음 리스팅 공유)을 만든다(순수). 주문검증 매칭과 해석 캐시를 합치되,
 * 딜은 첫 배정 origin에만 넣는다(HIGH#2 오염 차단). 주문검증 소스를 앞에 두면 그게 우선.
 * @param resolved  { dealId, origin }[] — 우선순위 높은 소스(주문검증)를 앞에 둔다
 */
export function buildOriginToDeals(resolved: { dealId: string; origin: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  // 딜은 첫 배정 origin에만(code-reviewer HIGH#2 — 한 딜이 두 origin에 걸리면 다른 상품 리뷰가
  // 한 코퍼스에 섞인다). 호출부가 주문검증 매칭을 먼저 push하므로 그게 우선한다.
  const originByDeal = new Map<string, string>();
  for (const r of resolved) {
    if (!r.origin || !r.dealId) continue;
    if (originByDeal.has(r.dealId)) continue; // 이미 배정됨(같거나 다른 origin) — 중복·오염 모두 차단
    originByDeal.set(r.dealId, r.origin);
    const arr = map.get(r.origin) ?? [];
    arr.push(r.dealId);
    map.set(r.origin, arr);
  }
  return map;
}

export type ReviewTarget = {
  originProductNo: string;
  channelProductNo: string; // 직접 URL 폴백용
  entryUrl: string | null; // 공유 딜 중 하나의 단축링크(로그인 벽 회피)
  dealIds: string[]; // 이 origin(리스팅)을 공유하는 딜들 — 스크랩 1회 후 전원에 배분
};

/**
 * 수집 대상(순수) — origin이 스토어 상품(채널번호 보유)에 있고 딜이 걸린 것만. entryUrl은
 * origin을 공유하는 딜의 단축링크(있으면). 스토어에 없는 origin(현재 미판매)은 제외.
 */
export function buildReviewTargets(
  originToDeals: Map<string, string[]>,
  pairs: { originProductNo: string; channelProductNos: string[] }[],
  entryUrlByOrigin?: Map<string, string | null>,
): ReviewTarget[] {
  const channelByOrigin = new Map<string, string>();
  for (const p of pairs) {
    if (p.channelProductNos[0]) channelByOrigin.set(p.originProductNo, p.channelProductNos[0]);
  }
  const targets: ReviewTarget[] = [];
  for (const [origin, dealIds] of originToDeals) {
    const channel = channelByOrigin.get(origin);
    if (!channel) continue; // 스토어에 없는 상품 — 공개 URL 못 만듦
    if (dealIds.length === 0) continue;
    targets.push({
      originProductNo: origin,
      channelProductNo: channel,
      entryUrl: entryUrlByOrigin?.get(origin) ?? null,
      dealIds,
    });
  }
  return targets;
}

/**
 * 최근 수집 스킵 게이트(순수, #42). lastCollectedAt이 minDays 이내인 origin은 이번 실행에서 제외 —
 * 후보가 캡보다 적으면 매 실행 같은 origin을 재스크랩하던 낭비 차단(prod 4연타 rate-limit 관측).
 * null(미수집)은 통과. 전부 최근이면 빈 배열 = 이번 실행 수집 0(정상 스킵).
 */
export function filterRecentlyCollected(
  targets: ReviewTarget[],
  lastCollectedByOrigin: Map<string, Date | null>,
  now: Date,
  minDays = REVIEW_RECOLLECT_MIN_DAYS,
): ReviewTarget[] {
  const cutoff = now.getTime() - minDays * 24 * 60 * 60 * 1000;
  return targets.filter((t) => {
    const last = lastCollectedByOrigin.get(t.originProductNo);
    return last == null || last.getTime() <= cutoff;
  });
}

/** 오래 안 걷은 origin 우선(순수). lastCollectedByOrigin null=미수집=최우선. 상한 적용. */
export function prioritizeTargets(
  targets: ReviewTarget[],
  lastCollectedByOrigin: Map<string, Date | null>,
  cap = REVIEW_MAX_ORIGINS_PER_RUN,
): ReviewTarget[] {
  const t = (o: string) => {
    const v = lastCollectedByOrigin.get(o);
    return v ? v.getTime() : 0;
  };
  return [...targets].sort((a, b) => t(a.originProductNo) - t(b.originProductNo)).slice(0, cap);
}

// ─────────────────────────── 오케스트레이션 ───────────────────────────

export type DealReviewResult = { dealId: string; ok: boolean; scraped?: number; stored?: number; added?: number; error?: string };

export type ReviewSyncResult = {
  resolved: number; // 이번 실행에 새로 해석한 딜 수
  candidates: number; // 수집 대상 origin 수(최근 수집 스킵 전 — prod 관측 연속성)
  skippedRecent: number; // 최근 수집(REVIEW_RECOLLECT_MIN_DAYS 이내)이라 제외한 origin 수 — #42
  attempted: number; // 스크랩 시도 origin 수
  succeeded: number; // 성공 origin 수
  failed: number;
  backlog: number;
  proxyApplied: boolean; // PROXY_URLS/FIXIE가 스크래퍼 브라우저에 주입됐는지(옵션 ③ 실측 — 값 아님)
  egressIp: string | null; // 스크래퍼 브라우저의 실제 egress IP(Naver가 보는 IP) — 프록시 적용·차단 원인 규명용
  deals: DealReviewResult[];
};

/**
 * 주문번호 역추적(Tier-1, 네트워크) — 딜의 캐시된 productOrderId로 네이버 주문을 조회해 원상품번호를
 * 얻고, 스토어 상품집합에 있으면 그 origin을 반환한다(실제 판매 주문 근거라 가장 정확). 원상품번호가
 * 스토어 밖이면 채널번호(productId)→origin 폴백. ⚠️ NaverOrderSnapshot.orders 블롭(1.5~5.2MB egress)은
 * 읽지 않는다 — 작은 productOrderId만 조회(오너 Supabase 절감 원칙).
 *
 * ⚠️ 적용 범위(code-reviewer LOW): cachedProductOrderIds는 **캠페인 마감 시에만** 채워지므로(유일 writer=
 * closed-campaign-cache) 진행 중 캠페인은 빈 배열→null(Tier-3/2로 폴백). 실질 확장 동력은 Tier-2/3이고
 * Tier-1은 마감 후 소급 정확도 보정이다. API 오류는 삼키지 않고 던진다(호출부가 재시도 — MEDIUM#2).
 */
async function resolveOriginViaOrders(
  productOrderIds: string[],
  storeOrigins: Set<string>,
  channelToOrigin: Map<string, string>,
): Promise<string | null> {
  if (productOrderIds.length === 0) return null;
  // .catch 없음(MEDIUM#2): API 오류는 던져 호출부가 캐시 안 남기고 다음 실행 재시도. 주문 미존재는 [].
  const orders = (await queryOrderDetails(productOrderIds)) as Array<{
    originalProductId?: unknown;
    productId?: unknown;
  }>;
  for (const o of orders) {
    const orig = o?.originalProductId != null ? String(o.originalProductId).trim() : '';
    if (orig && storeOrigins.has(orig)) return orig;
    const chan = o?.productId != null ? String(o.productId).trim() : '';
    const viaChan = chan ? channelToOrigin.get(chan) ?? null : null;
    if (viaChan && storeOrigins.has(viaChan)) return viaChan;
  }
  return null;
}

/**
 * 리뷰 수집 1회 실행. Drive 미연결이면 즉시 실패(코퍼스 저장처 없음 — 침묵 금지).
 * 단계: (1) 딜↔상품 해석(Tier-1 주문번호 · Tier-2 상품명 · Tier-3 단축링크, 캐시) (2) origin→딜 매칭
 * (3) origin당 스크랩 1회→공유 딜 배분. origin·딜별 실패는 삼키지 않고 결과에 싣는다(다음 계속).
 */
export async function runReviewSync(now: Date = new Date()): Promise<ReviewSyncResult> {
  await assertDriveReady();

  const [campaigns, allSalesCampaigns, pairs, cacheRows] = await Promise.all([
    // 주문검증 매칭용(2단계) — productId가 채워진 캠페인만(origin 직결).
    prisma.orderCampaign.findMany({
      where: { productId: { not: null } },
      select: { productId: true, salesCampaigns: { select: { dealId: true } } },
    }),
    // ⚠️ 해석 대상은 **모든 딜**에서 뽑는다(code-reviewer HIGH#1). productId 필터를 거치면 이미 매칭된
    //    소수만 대상이 돼 매칭이 발동하지 않는다. deal명(Tier-2)·주문번호(Tier-1)·단축링크(Tier-3)를 함께 가져온다.
    prisma.salesCampaign.findMany({
      select: {
        dealId: true,
        baseNaverLink: true,
        deal: { select: { dealName: true } },
        orderCampaign: { select: { cachedProductOrderIds: true } },
      },
    }),
    fetchStoreProductNumberPairs(),
    prisma.dealStoreLink.findMany({ select: { dealId: true, originProductNo: true, status: true, resolvedAt: true } }),
  ]);

  const channelToOrigin = buildChannelToOrigin(pairs);
  const storeOrigins = new Set(pairs.map((p) => p.originProductNo));

  // 이미 주문검증(productId) 매칭된 딜 — 해석 대상에서 제외.
  const productIdMatched = new Set<string>();
  for (const c of campaigns) for (const sc of c.salesCampaigns) productIdMatched.add(sc.dealId);

  // 딜별 단축링크(전 딜) — entryUrl(스크랩 진입)용. productId 매칭 딜도 포함.
  const shortLinkByDeal = new Map<string, string>();
  for (const sc of allSalesCampaigns) {
    if (shortLinkByDeal.has(sc.dealId)) continue;
    const link = pickShortLink([sc.baseNaverLink]);
    if (link) shortLinkByDeal.set(sc.dealId, link);
  }

  // 해석 입력(전 딜, productId 매칭분 제외) — 이름·단축링크·주문번호.
  const resolveInputs = buildDealResolveInputs(
    allSalesCampaigns.map((sc) => ({
      dealId: sc.dealId,
      dealName: sc.deal?.dealName,
      baseNaverLink: sc.baseNaverLink,
      productOrderIds: toProductOrderIds(sc.orderCampaign?.cachedProductOrderIds),
    })),
  ).filter((d) => !productIdMatched.has(d.dealId));

  const cache = new Map<string, ResolveCacheRow>(
    cacheRows.map((r) => [r.dealId, { dealId: r.dealId, status: r.status, resolvedAt: r.resolvedAt }]),
  );

  const startedAt = now.getTime();
  const ctx = await launchReviewContext();
  let resolvedCount = 0;
  const deals: DealReviewResult[] = [];
  let candidates = 0;
  let attempted = 0;

  // 옵션 ③ 실측: PROXY_URLS/FIXIE가 스크래퍼 브라우저에 주입되는지(값 아님·boolean). launchReviewContext와
  // 동일 env·동일 파서를 써서 실제 주입 여부와 일치시킨다.
  const proxyApplied =
    parseProxyForPlaywright(process.env.PROXY_URLS || process.env.FIXIE_URLS || process.env.FIXIE_URL) != null;

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // 옵션 ③ 실측 진단: 스크래퍼 브라우저의 실제 egress IP(Naver가 보는 IP)를 한 번 확인한다. 프록시가
    // 주입됐으면 이 IP는 프록시 IP여야 한다 — Vercel 데이터센터 IP면 프록시 미적용(파싱 실패 등), 프록시
    // IP인데 상품페이지가 여전히 로그인벽이면 그 IP도 차단됨(데이터센터급 프록시=주거용 아님). 실패해도
    // 수집은 진행(진단 보조). IP는 자기 인프라 값이라 PII 아님.
    let egressIp: string | null = null;
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      egressIp = await page.evaluate(() => {
        const t = (document.body?.innerText || '').trim();
        try {
          return (JSON.parse(t).ip as string) || null;
        } catch {
          return t.slice(0, 45) || null;
        }
      });
    } catch {
      egressIp = null;
    }

    // ── (1) 해석 단계 — 미해석 딜을 Tier-1(주문번호 역추적)→Tier-3(단축링크)→Tier-2(상품명) 순으로 매칭.
    //    정확도 순서(주문 근거 > 링크 > 이름)로 첫 성공을 채택해 DealStoreLink에 캐시(source 기록). ──
    const toResolve = dealsNeedingResolution(resolveInputs, cache, now);
    for (const dl of toResolve) {
      if (Date.now() - startedAt > REVIEW_RUN_BUDGET_MS) break;
      try {
        let origin: string | null = null;
        let source = 'NAME';
        let channelNo: string | null = null;
        let usedShortLink: string | null = null;
        // Tier-1: 주문번호 역추적(가장 정확 — 실제 판매 주문의 원상품번호). 블롭 미조회, 작은 ID만 조회.
        origin = await resolveOriginViaOrders(dl.productOrderIds, storeOrigins, channelToOrigin);
        if (origin) source = 'ORDER';
        // Tier-3: 단축링크 브라우저 해석
        if (!origin && dl.shortLink) {
          channelNo = await resolveShortLinkChannelNo(page, dl.shortLink);
          origin = channelNo ? channelToOrigin.get(channelNo) ?? null : null;
          source = 'LINK';
          usedShortLink = dl.shortLink;
        }
        // Tier-2: 상품명 단일 매칭(복수 후보는 null — 오귀속 방지)
        if (!origin) {
          origin = matchDealNameToStoreOrigin(dl.name, pairs);
          source = 'NAME';
        }
        const status = origin ? 'RESOLVED' : 'FAILED';
        const data = {
          source,
          // source=LINK일 때만 링크/채널 저장(code-reviewer MEDIUM#1 — Tier-3 시도 후 Tier-2로 넘어가면
          // usedShortLink/channelNo가 남아 source=NAME인데 non-null이 되는 계약 위반 방지).
          shortLink: source === 'LINK' ? usedShortLink : null,
          channelProductNo: source === 'LINK' ? channelNo : null,
          originProductNo: origin,
          status,
          lastError: origin ? null : '주문·링크·상품명 모두 스토어 미매칭(자사몰 밖 상품 가능)',
          resolvedAt: now,
        };
        await prisma.dealStoreLink.upsert({ where: { dealId: dl.dealId }, create: { dealId: dl.dealId, ...data }, update: data });
        if (origin) resolvedCount++;
        // 2단계 매칭은 아래 freshCache(DB 재조회)를 소스로 삼는다 — 방금 upsert가 반영됨. 인메모리 cache
        // 는 dealsNeedingResolution 입력용으로만 쓰고 이후 갱신하지 않는다(재조회가 정본).
      } catch (err) {
        // Tier-1 주문조회 API 오류 등은 캐시를 안 남기고 다음 실행에 재시도(FAILED 7일 락아웃 방지 —
        // code-reviewer MEDIUM#2: 일시 장애를 "미매칭"으로 굳히지 않는다). 침묵 금지 위해 로그.
        console.warn(`[review-collect] 딜 ${dl.dealId} 해석 실패(재시도 예정):`, err instanceof Error ? err.message : err);
      }
    }

    // ── (2) origin→딜 매칭 — 주문검증(OrderCampaign.productId) + 해석 캐시(RESOLVED) 합집합 ──
    const resolved: { dealId: string; origin: string }[] = [];
    for (const c of campaigns) {
      const origin = c.productId ? String(c.productId) : '';
      if (!origin) continue;
      for (const sc of c.salesCampaigns) resolved.push({ dealId: sc.dealId, origin });
    }
    const freshCache = await prisma.dealStoreLink.findMany({
      where: { status: 'RESOLVED', originProductNo: { not: null } },
      select: { dealId: true, originProductNo: true },
    });
    for (const r of freshCache) if (r.originProductNo) resolved.push({ dealId: r.dealId, origin: r.originProductNo });

    const originToDeals = buildOriginToDeals(resolved);

    // origin별 진입 단축링크(공유 딜 중 하나)
    const entryUrlByOrigin = new Map<string, string | null>();
    for (const [origin, dealIds] of originToDeals) {
      for (const d of dealIds) {
        const link = shortLinkByDeal.get(d);
        if (link) { entryUrlByOrigin.set(origin, link); break; }
      }
    }

    const targets = buildReviewTargets(originToDeals, pairs, entryUrlByOrigin);
    candidates = targets.length;

    // origin별 마지막 수집 시각(공유 딜들의 DealVocSource lastCollectedAt 중 최소)
    const allDealIds = targets.flatMap((t) => t.dealIds);
    const sources = allDealIds.length
      ? await prisma.dealVocSource.findMany({
          where: { dealId: { in: allDealIds }, channel: CHANNEL },
          select: { dealId: true, lastCollectedAt: true },
        })
      : [];
    const lastByDeal = new Map<string, Date | null>(sources.map((s) => [s.dealId, s.lastCollectedAt]));
    const lastByOrigin = new Map<string, Date | null>();
    for (const t of targets) {
      let min: Date | null = null;
      let anyNull = false;
      for (const d of t.dealIds) {
        const v = lastByDeal.get(d) ?? null;
        if (v == null) { anyNull = true; break; }
        if (min == null || v < min) min = v;
      }
      lastByOrigin.set(t.originProductNo, anyNull ? null : min);
    }

    // 최근 수집 스킵(#42) → 오래된 순 상한. 스킵분은 backlog가 아니라 의도적 유예(skippedRecent로 관측).
    const due = filterRecentlyCollected(targets, lastByOrigin, now);
    const picked = prioritizeTargets(due, lastByOrigin);

    // ── (3) 스크랩 단계 — origin당 1회 스크랩 후 공유 딜 전원에 배분 ──
    let merchantNo: string | null = null;
    for (let i = 0; i < picked.length; i++) {
      if (i > 0 && Date.now() - startedAt > REVIEW_RUN_BUDGET_MS) break; // 최소 1 origin은 항상 시도
      const t = picked[i];
      attempted++;
      let scraped: ScrapedReviews;
      try {
        scraped = await scrapeProductReviews(page, {
          productUrl: t.entryUrl ?? buildSmartstoreProductUrl(t.channelProductNo),
          originProductNo: t.originProductNo,
          merchantNoHint: merchantNo,
        });
        merchantNo = scraped.merchantNo;
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
        for (const d of t.dealIds) deals.push({ dealId: d, ok: false, error: msg });
        continue;
      }
      // 공유 딜 전원에 같은 리뷰셋 배분(묶음 리스팅 정직 공유)
      for (const d of t.dealIds) {
        try {
          const stored = await persistDealReviews({
            dealId: d,
            channel: CHANNEL,
            productUrl: buildSmartstoreProductUrl(t.channelProductNo),
            originProductNo: t.originProductNo,
            channelProductNo: t.channelProductNo,
            incoming: scraped.reviews,
          });
          deals.push({ dealId: d, ok: true, scraped: scraped.reviews.length, stored: stored.reviewCount, added: stored.added });
        } catch (err) {
          deals.push({ dealId: d, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' });
        }
      }
    }

    const succeededOrigins = picked
      .slice(0, attempted)
      .filter((t) => t.dealIds.some((d) => deals.find((r) => r.dealId === d && r.ok))).length;
    return {
      resolved: resolvedCount,
      candidates,
      skippedRecent: candidates - due.length,
      attempted,
      succeeded: succeededOrigins,
      failed: attempted - succeededOrigins,
      backlog: Math.max(0, due.length - attempted),
      proxyApplied,
      egressIp,
      deals,
    };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
