/**
 * 모바일 캠페인 상세 "매출 당겨서 새로고침" — 신선도 게이트·응답 해석 순수 로직.
 *
 * 서버(POST /api/mobile/order-sync)와 클라이언트(mobile-campaign-detail-sheet)가
 * 공유하는 순수 함수만 둔다. DB·네이버 API 호출 등 부수효과는 라우트가 소유한다.
 *
 * 계약(P7, 오너 승인 2026-07-15 · 설계 옵션 C):
 * - 모바일 매출 GET은 동기화 트리거 금지(불변). 수동 최신화는 이 POST 1종뿐.
 * - TTL 기본 90초 — 최신 NaverOrderSnapshot.lastCallTime이 TTL 이내면 네이버
 *   API를 호출하지 않고 fresh를 반환한다(429 아님 — 정상 200).
 * - env MOBILE_ORDER_REFRESH_TTL_S 로 조절 가능하되 60~120초로 클램프.
 * - 분당 한도 기본 3회(초과만 429) — env MOBILE_ORDER_REFRESH_RPM 1~10 클램프.
 */

export const DEFAULT_REFRESH_TTL_SECONDS = 90;
export const MIN_REFRESH_TTL_SECONDS = 60;
export const MAX_REFRESH_TTL_SECONDS = 120;

/** POST 대기 상한 — 초과 시 동기화는 백그라운드로 계속되고 syncing을 반환한다. */
export const SYNC_WAIT_TIMEOUT_MS = 8_000;

/** syncing 응답을 받은 클라이언트가 1회 재조회하기까지의 지연. */
export const SYNCING_FOLLOW_UP_DELAY_MS = 3_000;

/**
 * 분당 허용 요청 수 기본값 — 초과분만 429 (오너 지시 2026-07-15: 10 → 3 하향).
 * 당겨서 새로고침 1회당 스냅샷 창 재조회가 뒤따르므로(egress 1.5~5.2MB/회 실측이
 * 하향 배경), 분당 한도가 곧 egress 상한 레버다. env MOBILE_ORDER_REFRESH_RPM
 * 으로 1~10 사이에서 조절할 수 있다(오너가 1까지 낮출 수 있게).
 */
export const REFRESH_RATE_LIMIT_PER_MINUTE = 3;
export const MIN_REFRESH_RATE_PER_MINUTE = 1;
export const MAX_REFRESH_RATE_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

/**
 * env MOBILE_ORDER_REFRESH_RPM → 분당 허용 횟수. 미설정·비수치는 기본 3,
 * 수치는 1~10으로 클램프한다(TTL 클램프 resolveRefreshTtlSeconds와 동일 관용구).
 */
export function resolveRefreshRatePerMinute(
  raw: string | undefined = process.env.MOBILE_ORDER_REFRESH_RPM,
): number {
  if (raw == null || raw.trim() === "") return REFRESH_RATE_LIMIT_PER_MINUTE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return REFRESH_RATE_LIMIT_PER_MINUTE;
  return Math.min(
    MAX_REFRESH_RATE_PER_MINUTE,
    Math.max(MIN_REFRESH_RATE_PER_MINUTE, Math.trunc(parsed)),
  );
}

/**
 * env MOBILE_ORDER_REFRESH_TTL_S → TTL 초. 미설정·비수치는 기본 90초,
 * 수치는 60~120초로 클램프한다.
 */
export function resolveRefreshTtlSeconds(
  raw: string | undefined = process.env.MOBILE_ORDER_REFRESH_TTL_S,
): number {
  if (raw == null || raw.trim() === "") return DEFAULT_REFRESH_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_TTL_SECONDS;
  return Math.min(
    MAX_REFRESH_TTL_SECONDS,
    Math.max(MIN_REFRESH_TTL_SECONDS, Math.trunc(parsed)),
  );
}

/**
 * 신선도 게이트. lastCallTime이 없거나(스냅샷 미존재) 경과가 TTL 이상이면
 * 동기화를 트리거한다. 경계: 경과 == TTL 인 순간부터 stale.
 */
export function shouldTriggerSync(
  lastCallTime: Date | null | undefined,
  now: Date,
  ttlSeconds: number,
): boolean {
  if (!lastCallTime) return true;
  return now.getTime() - lastCallTime.getTime() >= ttlSeconds * 1000;
}

// ============================================================================
// 응답 형태(status)와 클라이언트 해석
// ============================================================================

export type MobileOrderRefreshResponse =
  | { status: "fresh"; asOf: string; nextAllowedAt: string }
  | { status: "syncing"; asOf: string | null }
  | { status: "synced"; asOf: string; changed: number };

export function buildFreshResponse(
  lastCallTime: Date,
  ttlSeconds: number,
): Extract<MobileOrderRefreshResponse, { status: "fresh" }> {
  return {
    status: "fresh",
    asOf: lastCallTime.toISOString(),
    nextAllowedAt: new Date(lastCallTime.getTime() + ttlSeconds * 1000).toISOString(),
  };
}

export type RefreshFollowUpAction =
  | { kind: "reload" }
  | { kind: "reloadAfterDelay"; delayMs: number }
  | { kind: "alreadyFresh"; caption: string };

export function buildAlreadyFreshCaption(asOf: string | null): string {
  if (!asOf) return "이미 최신";
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return "이미 최신";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `이미 최신 · ${hh}:${mm}`;
}

/**
 * POST 응답 → 클라이언트 후속 행동.
 * - synced + changed>0 → 매출 GET 즉시 재조회
 * - syncing → 3초 뒤 1회 재조회(백그라운드 동기화 완주 대기)
 * - fresh · synced(changed=0) → 재조회 없음, "이미 최신 · HH:MM" 캡션
 */
export function interpretRefreshResponse(
  payload: MobileOrderRefreshResponse,
): RefreshFollowUpAction {
  if (payload.status === "syncing") {
    return { kind: "reloadAfterDelay", delayMs: SYNCING_FOLLOW_UP_DELAY_MS };
  }
  if (payload.status === "synced" && payload.changed > 0) {
    return { kind: "reload" };
  }
  return { kind: "alreadyFresh", caption: buildAlreadyFreshCaption(payload.asOf) };
}

// ============================================================================
// 분당 레이트리밋(인메모리 고정창) — 인스턴스 로컬이면 충분(사용자=오너 1인)
// ============================================================================

export interface RateWindowState {
  windowStartMs: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  state: RateWindowState;
  /** allowed=false일 때만: 창이 리셋될 때까지 남은 초(최소 1). */
  retryAfterSeconds?: number;
}

export function applyRateLimit(
  state: RateWindowState | null | undefined,
  nowMs: number,
  limit: number = REFRESH_RATE_LIMIT_PER_MINUTE,
): RateLimitDecision {
  if (!state || nowMs - state.windowStartMs >= RATE_WINDOW_MS) {
    return { allowed: true, state: { windowStartMs: nowMs, count: 1 } };
  }
  if (state.count < limit) {
    return { allowed: true, state: { windowStartMs: state.windowStartMs, count: state.count + 1 } };
  }
  return {
    allowed: false,
    state,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((state.windowStartMs + RATE_WINDOW_MS - nowMs) / 1000),
    ),
  };
}

// ============================================================================
// 타임아웃 레이스 — 동기화 Promise는 계속 진행되고 응답만 먼저 돌아간다
// ============================================================================

export type RaceWithTimeoutResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<RaceWithTimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
