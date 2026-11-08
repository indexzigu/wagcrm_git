/**
 * [셀러분석] Tier0 릴스 조회수 보강 — Apify `instagram-reel-scraper` (유료, 월 상한 있음).
 *
 * 왜 필요한가: Tier0(Graph business_discovery, 무료)는 릴스 조회수를 주지 않는다
 * (`graphScraper.ts` 의 `video_view_count: null`). 그래서 「릴스 조회 배수」
 * (`metrics.reach`)가 Tier0 셀러에게는 `NO_VIEWS` 로만 뜬다.
 *
 * 범위(오너 확정, 설계 §1-4 (A)):
 * - **수동 분석 경로에서만** 부른다 — 워터폴의 `enrichReelViews: true` 옵션
 *   를 켜는 곳은 분석 라우트가 `?reelViews=1` 을 받았을 때뿐이다. 크론은 이 모듈을 부르지 않는다
 *   (`reel-views-callers.contract.test.ts` 가 호출부를 고정).
 * - **월 상한**(기본 $2, env `APIFY_REEL_VIEWS_MONTHLY_CAP_USD` 로 덮어쓰기) — 이번 달(KST)
 *   기록 지출 + 이번 호출의 최대 비용이 상한을 넘으면 호출하지 않는다.
 * - 유료 추가 옵션(공유 수·자막·영상 다운로드)은 **전부 끈다** — 이 셋이 켜지면 건당 단가가
 *   몇 배~수십 배가 된다.
 * - 실패는 분석을 깨뜨리지 않는다. 조회수는 비어 있는 채로 남고(카드 「조회수 미수집」),
 *   실패 호출도 `ApiCallLog` 1행으로 남긴다(P0 No Silent Failure).
 * - 기존 Tier1/Tier2 의 조회수 폴백 순서는 건드리지 않는다. 여기서는 **조회수가 없는 Tier0 릴스만** 채운다.
 *
 * 지출 기록 규약은 `apify-comment-usage.ts` 와 같다(provider=플랫폼, permissionScope=벤더·경로,
 * 토큰은 비가역 지문만). 스키마 변경 없음.
 */
import { getApifyToken } from './apify';
import {
  describeApifyToken,
  truncateReason,
  NO_HTTP_RESPONSE,
} from './apify-comment-usage';
import { kstMonthStartUtc } from './apify-comment-usage-report';
import { shortcodeFromPermalink } from './graphScraper';
import type { LosslessSellerData, RawPost, VideoViewSource } from './types';
import { getPrisma } from '@/lib/prisma';

const REEL_ACTOR_ID = 'apify~instagram-reel-scraper';

/** `ApiCallLog.permissionScope` — 월 지출 합산 쿼리가 이 값으로 인덱스를 탄다. */
export const APIFY_REEL_VIEWS_SCOPE = 'apify_reel_scraper';
/** `ApiCallLog.provider` — 기존 규약(provider=플랫폼). */
export const APIFY_REEL_VIEWS_PROVIDER = 'INSTAGRAM';

/**
 * `ApiCallLog.endpoint` 라벨 — 호스트·쿼리 없는 경로만. 실제 URL 에는 `?token=` 이 붙는다(P0).
 */
export const REEL_VIEWS_ENDPOINT_LABEL = `POST /v2/acts/${REEL_ACTOR_ID}/run-sync-get-dataset-items`;

/** 프로필당 최대 릴스 수 = 1회 호출 지출 상한의 근거. */
export const REEL_RESULTS_LIMIT = 15;

/**
 * 단가(설계 §8, 액터 공개 pricingInfos 실측 2026-11-08 — PAY_PER_EVENT).
 * FREE 등급 값을 쓴다 — 등급 중 가장 비싸므로 **상한 추정**으로 안전하다.
 */
export const REEL_COST_USD_PER_REEL = 0.0026;
export const REEL_ACTOR_START_COST_USD = 0.001;

/** 월 상한 기본값(오너 확정). prod env 변경 없이 동작하도록 코드에 둔다. */
export const DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD = 2;
export const REEL_VIEWS_CAP_ENV = 'APIFY_REEL_VIEWS_MONTHLY_CAP_USD';

/**
 * 동기 실행 대기 상한. 분석 라우트 maxDuration(300s) 안에 Tier0·Gemini 가 함께 들어가야 해서
 * 보강 하나가 요청 전체를 붙잡지 않게 끊는다(끊긴 호출은 실패로 기록되고 분석은 진행).
 */
export const REEL_FETCH_TIMEOUT_MS = 120_000;

/** 1회 호출의 최대 비용(USD) — 결과 상한 × 건당 + 실행 시작. */
export function maxReelCallCostUsd(resultsLimit = REEL_RESULTS_LIMIT): number {
  return roundUsd(resultsLimit * REEL_COST_USD_PER_REEL + REEL_ACTOR_START_COST_USD);
}

/** 수신 릴스 수 → 추정 비용(USD). 호출이 나갔으면 실행 시작 비용은 붙는다. */
export function estimateReelCallCostUsd(receivedReels: number): number {
  const n = Number.isFinite(receivedReels) && receivedReels > 0 ? receivedReels : 0;
  return roundUsd(n * REEL_COST_USD_PER_REEL + REEL_ACTOR_START_COST_USD);
}

function roundUsd(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * 월 상한(USD). env 가 비었거나 숫자가 아니거나 음수면 기본값($2)으로 돌아가되 조용히 넘기지 않는다.
 * `0` 은 유효값 = 보강 끔.
 */
export function resolveMonthlyCapUsd(raw: string | undefined = process.env[REEL_VIEWS_CAP_ENV]): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[reel-views] ${REEL_VIEWS_CAP_ENV} 값이 올바르지 않아 기본 상한 $${DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD} 를 씁니다.`
    );
    return DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD;
  }
  return n;
}

/** 조회수 보강 대상: 릴스 · 조회수 없음 · shortcode 있음 (순수). */
export function pickReelsMissingViews(posts: readonly RawPost[]): RawPost[] {
  return posts.filter(
    (p) => p.media_type === 'reel' && typeof p.video_view_count !== 'number' && !!p.shortcode
  );
}

/** 액터 항목 1개의 조회수 — `videoViewCount`(views) 우선, 없으면 `videoPlayCount`(plays) (순수). */
export function pickReelScraperView(item: any): { count: number; source: VideoViewSource } | null {
  const views = item?.videoViewCount;
  if (typeof views === 'number' && Number.isFinite(views) && views >= 0) return { count: views, source: 'views' };
  const plays = item?.videoPlayCount;
  if (typeof plays === 'number' && Number.isFinite(plays) && plays >= 0) return { count: plays, source: 'plays' };
  return null;
}

/** 액터 출력 → shortcode → 조회수 맵 (순수). shortCode 필드가 없으면 url 에서 역산. */
export function groupReelViewsByShortcode(items: unknown[]): Map<string, { count: number; source: VideoViewSource }> {
  const map = new Map<string, { count: number; source: VideoViewSource }>();
  for (const item of items as any[]) {
    const code =
      (typeof item?.shortCode === 'string' && item.shortCode) || shortcodeFromPermalink(item?.url) || null;
    const view = pickReelScraperView(item);
    if (!code || !view || map.has(code)) continue;
    map.set(code, view);
  }
  return map;
}

/** 조회수 없는 Tier0 릴스에만 값을 넣는다. 이미 숫자가 있는 게시물은 건드리지 않는다 (순수 — 입력 변경). */
export function mergeReelViews(
  posts: RawPost[],
  byShortcode: Map<string, { count: number; source: VideoViewSource }>
): { filled: number; views: number; plays: number } {
  let views = 0;
  let plays = 0;
  for (const post of pickReelsMissingViews(posts)) {
    const hit = byShortcode.get(post.shortcode as string);
    if (!hit) continue;
    post.video_view_count = hit.count;
    post.view_source = hit.source;
    if (hit.source === 'views') views++;
    else plays++;
  }
  return { filled: views + plays, views, plays };
}

// ---------- 지출 기록 ----------

export type ReelViewsCallUsage = {
  /** 조회수가 비어 있던 Tier0 릴스 수 */
  targetReels: number;
  resultsLimit: number;
  /** 액터가 돌려준 릴스 수 = 과금 단위 */
  receivedReels: number;
  filledReels: number;
  filledFromViews: number;
  filledFromPlays: number;
  durationMs: number;
  statusCode: number;
  ok: boolean;
  errorMessage: string | null;
  tokenFingerprint: string | null;
  endpoint: string;
  /** 호출 전 이번 달 기록 지출(USD) — 상한 판정의 근거 */
  monthSpentBeforeUsd: number;
  capUsd: number;
};

/**
 * 이 호출의 추정 비용. **실패는 최대 비용으로 잡는다** — 실패 호출도 액터가 일부 결과를 쓰고
 * 과금했을 수 있는데 우리는 그 수를 모른다. 과소 기록이 쌓이면 월 상한이 새므로 위쪽으로 잡는다.
 */
export function reelCallCostUsd(usage: Pick<ReelViewsCallUsage, 'ok' | 'receivedReels' | 'resultsLimit'>): number {
  return usage.ok ? estimateReelCallCostUsd(usage.receivedReels) : maxReelCallCostUsd(usage.resultsLimit);
}

/** `ApiCallLog.metadata` (순수). 키를 늘릴 때 시크릿이 아닌지 먼저 확인할 것(P0). */
export function buildReelViewsUsageMetadata(usage: ReelViewsCallUsage) {
  return {
    targetReels: usage.targetReels,
    resultsLimit: usage.resultsLimit,
    receivedReels: usage.receivedReels,
    filledReels: usage.filledReels,
    filledFromViews: usage.filledFromViews,
    filledFromPlays: usage.filledFromPlays,
    durationMs: usage.durationMs,
    estimatedCostUsd: reelCallCostUsd(usage),
    costPerReelUsd: REEL_COST_USD_PER_REEL,
    actorStartCostUsd: REEL_ACTOR_START_COST_USD,
    monthSpentBeforeUsd: usage.monthSpentBeforeUsd,
    capUsd: usage.capUsd,
    tokenFingerprint: usage.tokenFingerprint,
  };
}

/**
 * 호출 결과 영속 — 성공·실패 양쪽. 기록 실패는 분석을 깨뜨리지 않되 콘솔로 표면화하고 false 를
 * 돌려준다(호출자가 그 비용을 프로세스 내 미기록 지출로 계상해 상한이 새지 않게 한다).
 */
export async function recordReelViewsUsage(usage: ReelViewsCallUsage): Promise<boolean> {
  try {
    await getPrisma().apiCallLog.create({
      data: {
        provider: APIFY_REEL_VIEWS_PROVIDER,
        permissionScope: APIFY_REEL_VIEWS_SCOPE,
        endpoint: usage.endpoint,
        statusCode: usage.statusCode,
        success: usage.ok,
        errorMessage: usage.errorMessage,
        metadata: JSON.stringify(buildReelViewsUsageMetadata(usage)),
      },
    });
    return true;
  } catch (err) {
    console.error('[reel-views] 계측 기록 실패(분석 자체는 영향 없음 · 비용은 미기록 지출로 계상):', err);
    return false;
  }
}

/**
 * 이번 달(KST 달력) 기록 지출 합계(USD). metadata 를 못 읽는 행은 **최대 비용으로 센다**
 * (과소 집계 → 상한 초과 방지) — 그 사실은 콘솔로 남긴다.
 * DB 조회 자체가 실패하면 throw — 호출부는 **호출하지 않는 쪽**으로 닫는다.
 */
export async function sumMonthReelViewsSpendUsd(now: Date = new Date()): Promise<number> {
  const rows = await getPrisma().apiCallLog.findMany({
    where: { permissionScope: APIFY_REEL_VIEWS_SCOPE, calledAt: { gte: kstMonthStartUtc(now, 0) } },
    select: { metadata: true },
  });
  let total = 0;
  let malformed = 0;
  for (const row of rows) {
    let cost: unknown = undefined;
    try {
      cost = row.metadata ? JSON.parse(row.metadata)?.estimatedCostUsd : undefined;
    } catch {
      cost = undefined;
    }
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      total += cost;
    } else {
      malformed++;
      total += maxReelCallCostUsd();
    }
  }
  if (malformed > 0) {
    console.error(`[reel-views] 이번 달 지출 행 ${malformed}건의 비용을 읽지 못해 최대 비용으로 셌습니다.`);
  }
  return roundUsd(total);
}

// ---------- 액터 호출 ----------

/** 액터 입력 — 프로필(계정 이름) 1개 · 결과 상한 · 유료 추가 옵션 전부 끔 (순수). */
export function buildReelScraperInput(handle: string, resultsLimit = REEL_RESULTS_LIMIT) {
  return {
    username: [handle],
    resultsLimit,
    includeSharesCount: false,
    includeTranscript: false,
    includeDownloadedVideo: false,
  };
}

type FetchOutcome = {
  items: unknown[];
  statusCode: number;
  ok: boolean;
  errorMessage: string | null;
};

/** throw 하지 않는다 — 실패도 관측 대상이라 `ok=false` 로 돌려준다(댓글 어댑터와 같은 계약). */
async function fetchReels(handle: string, token: string): Promise<FetchOutcome> {
  let statusCode = NO_HTTP_RESPONSE;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${REEL_ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReelScraperInput(handle)),
        signal: AbortSignal.timeout(REEL_FETCH_TIMEOUT_MS),
      }
    );
    statusCode = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { items: [], statusCode, ok: false, errorMessage: truncateReason(`Apify reel run failed: ${body}`) };
    }
    const json = await res.json();
    return { items: Array.isArray(json) ? json : [], statusCode, ok: true, errorMessage: null };
  } catch (error) {
    return { items: [], statusCode, ok: false, errorMessage: truncateReason(error) };
  }
}

// ---------- 오케스트레이션 ----------

/**
 * In-flight reservation (USD) for calls that started but have not written their ApiCallLog row
 * yet. The cap check reads spend from ApiCallLog, which is only written after the call returns
 * (up to the fetch timeout), so two concurrent "분석" runs would otherwise both pass the check.
 * Process-local: the self-hosted server runs a single Node process; a multi-instance deployment
 * would need a DB-level reservation instead.
 */
let inFlightReservedUsd = 0;

/** Owner-facing notice when the paid reel-view call failed (actor error or unexpected throw). */
const REEL_VIEWS_FAILED_NOTICE = '릴스 조회수 가져오기에 실패해 조회수 없이 분석했습니다';

/**
 * Paid calls whose ApiCallLog row failed to write, booked at max cost so the cap check does not
 * hand the same headroom out again. Process-local and conservative: it is never released (a
 * restart resets it, by which time the console error has surfaced the logging failure).
 */
let unrecordedSpendUsd = 0;

/** Test-only: reset the in-process reservations between tests. */
export function __resetReelViewsInFlightForTest(): void {
  inFlightReservedUsd = 0;
  unrecordedSpendUsd = 0;
}

export type ReelViewsEnrichResult =
  | { status: 'skipped'; reason: string }
  | { status: 'called'; usage: ReelViewsCallUsage };

/**
 * Tier0 데이터에 릴스 조회수를 보강한다. **throw 하지 않는다** — 어떤 실패도 Tier0 결과를
 * Tier1(유료 폴백)로 강등시키면 안 된다. 결과는 `debug_info` 와 콘솔에도 남는다.
 *
 * skip(호출 없음 = 지출 없음 = 기록 없음): 토큰 미설정 · 릴스 0개 · 모든 릴스에 이미 조회수 ·
 * 월 상한 · 이번 달 지출 조회 실패(닫힌 쪽으로).
 */
export async function enrichTier0ReelViews(
  data: LosslessSellerData,
  now: Date = new Date()
): Promise<ReelViewsEnrichResult> {
  const skip = (reason: string): ReelViewsEnrichResult => {
    data.debug_info = `${data.debug_info ?? ''} Reel views skipped: ${reason}.`;
    return { status: 'skipped', reason };
  };

  try {
    const reels = data.raw_posts.filter((p) => p.media_type === 'reel');
    if (reels.length === 0) return skip('no reels');
    const targets = pickReelsMissingViews(data.raw_posts);
    if (targets.length === 0) return skip('reels already have views');

    const handle = String(data.profile?.username || data.seller_id || '').replace(/^@+/, '').trim();
    if (!handle) return skip('no handle');

    const token = getApifyToken();
    if (!token) {
      data.reel_views_notice = 'Apify 토큰이 없어 릴스 조회수를 채우지 않았습니다';
      return skip('APIFY_API_TOKEN 미설정');
    }

    const capUsd = resolveMonthlyCapUsd();
    let monthSpentBeforeUsd: number;
    try {
      monthSpentBeforeUsd = await sumMonthReelViewsSpendUsd(now);
    } catch (err) {
      console.error('[reel-views] 이번 달 지출 조회 실패 — 상한을 확인할 수 없어 호출하지 않습니다:', err);
      data.reel_views_notice =
        '이번 달 사용액을 확인하지 못해 릴스 조회수를 채우지 않았습니다(유료 호출 차단)';
      return skip('monthly spend lookup failed');
    }
    const maxCost = maxReelCallCostUsd();
    if (monthSpentBeforeUsd + unrecordedSpendUsd + inFlightReservedUsd + maxCost > capUsd) {
      const reason =
        `monthly cap reached (spent $${monthSpentBeforeUsd} + unrecorded $${unrecordedSpendUsd}` +
        ` + in-flight $${inFlightReservedUsd}` +
        ` + max $${maxCost} > cap $${capUsd})`;
      console.warn(`[reel-views] 월 상한으로 조회수 보강을 건너뜁니다: ${reason}`);
      data.reel_views_notice = `이번 달 상한 $${capUsd}에 도달해 릴스 조회수를 채우지 않았습니다`;
      return skip(reason);
    }

    // Reserve synchronously right after the check (no await in between) so a concurrent run
    // sees it; released once the ApiCallLog row is written (or on any throw).
    inFlightReservedUsd += maxCost;
    try {
      const startedAt = Date.now();
      const outcome = await fetchReels(handle, token);
      const byShortcode = outcome.ok ? groupReelViewsByShortcode(outcome.items) : new Map();
      const merged = mergeReelViews(data.raw_posts, byShortcode);

      const usage: ReelViewsCallUsage = {
        targetReels: targets.length,
        resultsLimit: REEL_RESULTS_LIMIT,
        receivedReels: outcome.items.length,
        filledReels: merged.filled,
        filledFromViews: merged.views,
        filledFromPlays: merged.plays,
        durationMs: Date.now() - startedAt,
        statusCode: outcome.statusCode,
        ok: outcome.ok,
        errorMessage: outcome.errorMessage,
        tokenFingerprint: describeApifyToken(token),
        endpoint: REEL_VIEWS_ENDPOINT_LABEL,
        monthSpentBeforeUsd,
        capUsd,
      };
      if (!(await recordReelViewsUsage(usage))) unrecordedSpendUsd += maxCost;

      if (usage.ok) {
        data.debug_info =
          `${data.debug_info ?? ''} Apify reel views filled: ${merged.filled}/${targets.length} reels` +
          ` (${usage.receivedReels} received, ${usage.durationMs}ms).`;
      } else {
        console.error(
          `[reel-views] 릴스 조회수 보강 실패(분석은 진행) handle=${handle} status=${usage.statusCode}: ${usage.errorMessage}`
        );
        data.debug_info = `${data.debug_info ?? ''} Apify reel views failed: ${usage.errorMessage}`;
        data.reel_views_notice = REEL_VIEWS_FAILED_NOTICE;
      }
      return { status: 'called', usage };
    } finally {
      inFlightReservedUsd = Math.max(0, inFlightReservedUsd - maxCost);
    }
  } catch (error) {
    // 안전망: 여기서 throw 가 새면 성공한 Tier0 가 유료 Tier1 로 강등된다.
    const msg = truncateReason(error);
    console.error(`[reel-views] 릴스 조회수 보강 중 예외(분석은 진행): ${msg}`);
    data.debug_info = `${data.debug_info ?? ''} Apify reel views failed: ${msg}`;
    data.reel_views_notice = REEL_VIEWS_FAILED_NOTICE;
    return { status: 'skipped', reason: `error: ${msg}` };
  }
}
