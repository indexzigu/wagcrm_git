/**
 * 네이버 커머스 API 호출 계측 — `ApiCallLog` 1행 단위(P7의 Paid-Call Observability 규약 재사용).
 *
 * 왜 필요한가: 네이버 호출은 지금까지 **한 건도 계측되지 않았다**(실측 2026-07-30:
 * `ApiCallLog` provider 는 INSTAGRAM 35행·YOUTUBE 1행뿐, NAVER 0행). 그래서
 * "주문확인 1클릭이 네이버를 몇 번 부르는가"를 코드 기반 상한 계산으로만 말할 수
 * 있었고, 조회 범위 최적화의 효과도 주장으로만 남았다. 네이버는 유료는 아니지만
 * 레이트리밋(429)이 있어 호출 수가 곧 실패 위험이다.
 *
 * 무엇을 남기고 무엇을 남기지 않는가(볼륨 규율 — 아래 "왜 전량이 아닌가" 참조):
 *  - **오퍼레이션 요약 1행**: 운영자가 명시적으로 누른 작업(주문확인·발주요청) 1회당 1행.
 *    논리 호출 수·HTTP 시도 수·429 재시도 수·401 재발급 수·생략 수를 함께 담아 **최적화
 *    전후를 같은 지표로** 비교한다.
 *  - **종국 실패 1행**: `apiRequest` 가 **포기한** 실패만(P0 No Silent Failure).
 *  - ⛔ **행을 만들지 않는 것 2종: ①성공한 개별 호출 ②재시도로 이어지는 일시적 실패
 *    (401 토큰만료·429 레이트리밋).** 둘은 같은 이유로 고볼륨이다 — 동기화·상품검색은
 *    대시보드 GET 마다 나가고, 429 는 청크 19개 × 외부 2회 × 내부 4회 = 150행대까지
 *    간다. 그리고 `dashboard-data.ts` 가 ApiCallLog 를 **provider 무관 최근 20행**만
 *    읽어 UI 3곳에 뿌리므로(`take: 20` — 증빙 페이지의 로그 표·캠페인 사이드패널·정산
 *    패널), 고볼륨 NAVER 행이 상위 20을 점거하면 **Meta App Review 증빙 표에 Instagram
 *    행이 0개**가 된다. 그래서 이 둘의 호출량은 요약 행의 카운터로만 센다.
 *    ⚠️ 401·429 를 개별 행으로 되살리지 말 것 — 그게 정확히 위 실패 모드다.
 *  - 따라서 **동기화(CHANGED/FULL)·상품검색의 성공 호출량, 그리고 일시적 재시도의 개별
 *    이력은 계측되지 않는다.** "네이버 호출 전량 계측"이라고 읽지 말 것.
 *  - ⚠️ **토큰 발급 호출(`/v1/oauth2/token`)도 `httpAttempts` 에 안 들어간다** —
 *    `getAccessToken`/`getNaverToken` 은 tally 컨텍스트 밖에서 캐시(약 2시간)를 두고
 *    돌아 체계적으로 과소집계된다. 콜드 인스턴스 + 401 재발급이면 1클릭당 미계측 2건.
 *    "1클릭이 네이버를 몇 번 때리는가"를 정밀하게 봐야 하면 이 항목을 먼저 닫아야 한다.
 *
 * ⚠️ 시크릿·PII 금지(P0, 레포 PUBLIC): `endpoint` 는 **호스트·쿼리 없는 경로 라벨**만
 * 쓴다(쿼리에 조회 파라미터가 실리고, 다른 벤더에서 토큰이 쿼리에 오는 전례가 있다).
 * `metadata` 에 셀러 실명·구매자 정보·실측 매출을 넣지 않는다 — 캠페인 id 같은
 * 비식별 키만 담는다. 계약은 `naver-api-usage.test.ts` 가 기계로 강제한다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getPrisma } from '@/lib/prisma';
import { truncateReason } from '@/lib/seller-analysis/apify-comment-usage';

/** `ApiCallLog.provider` — `ApiProvider` 유니온(`src/lib/crm-types.ts`)과 일치해야 한다. */
export const NAVER_API_PROVIDER = 'NAVER';

/** 개별 호출 실패 1건의 `permissionScope`. */
export const NAVER_CALL_FAILURE_SCOPE = 'naver_api_call';

/** 오퍼레이션 요약의 `permissionScope` 접두사 — 월별 집계가 이 값으로 인덱스를 탄다. */
export const NAVER_OP_SCOPE_PREFIX = 'naver_op_';

/**
 * 계측 대상 오퍼레이션. 운영자가 **명시적으로 트리거**하는 작업만 요약 행을 남긴다
 * (배경 동기화·상품검색은 위 볼륨 규율에 따라 요약 대상이 아니다).
 */
export type NaverOperation =
  /** 주문확인 버튼 = 전 기간 재조회 + 발주확인 + 발주서 다운로드(execute/stream) */
  | 'confirm_order'
  /** 발주요청(이메일 첨부) 경로의 발주서 생성(execute) */
  | 'order_excel';

export function naverOpScope(operation: NaverOperation): string {
  return `${NAVER_OP_SCOPE_PREFIX}${operation}`;
}

/**
 * `ApiCallLog.endpoint` 라벨 — 호스트·쿼리를 제거한 경로만 남긴다(P0).
 * `apiRequest` 는 path 와 query 를 따로 받으므로 보통 이미 깨끗하지만,
 * 호출부가 쿼리를 붙여 넘겨도 새지 않도록 방어적으로 자른다.
 */
export function toNaverEndpointLabel(path: string | null | undefined): string {
  const raw = String(path ?? '').trim();
  if (!raw) return '/unknown';
  const pathOnly = raw.split(/[?#]/)[0];
  // 절대 URL 이 실려 와도 호스트를 버린다.
  const withoutOrigin = pathOnly.replace(/^https?:\/\/[^/]+/i, '');
  const normalized = withoutOrigin || '/unknown';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

// ============================================================================
// 호출 집계기(tally) — 오퍼레이션 1회 동안의 호출 수를 센다.
// ============================================================================

export interface NaverCallTally {
  /** 호출부가 의도한 **논리 호출** 수(= 조회 청크 수). 내부 재시도는 포함하지 않는다. */
  logicalCalls: number;
  /** 실제 나간 **HTTP 시도** 수. 401·429 재시도를 포함하므로 논리 호출보다 클 수 있다. */
  httpAttempts: number;
  /** 429 로 재시도한 횟수 — 레이트리밋 압력 지표(현재 `apiRequest` 가 조용히 삼킨다). */
  rateLimitRetries: number;
  /** 401(토큰 만료)로 토큰을 재발급하고 재시도한 횟수 — 자기치유 정상 이벤트다. */
  tokenRefreshes: number;
  /** 조회를 **생략**한 논리 단위 수. 스킵 최적화의 효과가 이 값으로 드러난다(최적화 전엔 0). */
  skipped: number;
  /** 엔드포인트 라벨별 HTTP 시도 수 — 어느 엔드포인트가 호출을 먹는지 분해한다. */
  httpAttemptsByEndpoint: Record<string, number>;
}

export function createNaverCallTally(): NaverCallTally {
  return {
    logicalCalls: 0,
    httpAttempts: 0,
    rateLimitRetries: 0,
    tokenRefreshes: 0,
    skipped: 0,
    httpAttemptsByEndpoint: {},
  };
}

/** 호출부가 "조회 1건을 시도한다"고 선언할 때(청크 1개). */
export function noteNaverLogicalCall(tally: NaverCallTally | undefined, count = 1): void {
  if (!tally) return;
  tally.logicalCalls += count;
}

/** 호출부가 "조회 1건을 생략했다"고 선언할 때(스킵 최적화 계측). */
export function noteNaverSkippedCall(tally: NaverCallTally | undefined, count = 1): void {
  if (!tally) return;
  tally.skipped += count;
}

/** `apiRequest` 가 실제 HTTP 시도를 **하기 직전**마다(재시도도 각각 1시도). */
export function noteNaverHttpAttempt(
  tally: NaverCallTally | undefined,
  endpointLabel: string,
): void {
  if (!tally) return;
  tally.httpAttempts += 1;
  tally.httpAttemptsByEndpoint[endpointLabel] =
    (tally.httpAttemptsByEndpoint[endpointLabel] || 0) + 1;
}

/** 429 를 만나 재시도로 넘어갈 때. 시도 수는 다음 `noteNaverHttpAttempt` 가 센다. */
export function noteNaverRateLimitRetry(tally: NaverCallTally | undefined): void {
  if (!tally) return;
  tally.rateLimitRetries += 1;
}

/** 401(토큰 만료)로 토큰을 재발급하고 재시도할 때. */
export function noteNaverTokenRefresh(tally: NaverCallTally | undefined): void {
  if (!tally) return;
  tally.tokenRefreshes += 1;
}

/**
 * tally 를 오퍼레이션 실행 컨텍스트에 실어 `apiRequest` 가 **시그니처 변경 없이** 찾게 한다.
 * (5곳 넘는 호출부에 인자를 추가하면 그중 하나만 빠져도 계측에 구멍이 난다.)
 */
const tallyStore = new AsyncLocalStorage<NaverCallTally>();

export function runWithNaverCallTally<T>(tally: NaverCallTally, fn: () => Promise<T>): Promise<T> {
  return tallyStore.run(tally, fn);
}

/**
 * 현재 컨텍스트의 tally. `apiRequest` 는 **진입 시 동기적으로** 읽어 지역 변수에 담아야 한다 —
 * 내부 큐(p-queue)가 실행을 지연시키므로 컨텍스트를 나중에 읽으면 유실될 수 있다.
 */
export function getNaverCallTally(): NaverCallTally | undefined {
  return tallyStore.getStore();
}

// ============================================================================
// 기록(쓰기) — 실패해도 절대 throw 하지 않는다(계측이 기능을 깨면 안 된다).
// ============================================================================

/**
 * 계측 쓰기의 상한(ms). 기록은 `apiRequest` 의 p-queue 슬롯 안이나 스트림 라우트의
 * finally(=`controller.close()` 직전)에서 await 되므로, **실패가 아니라 hang 하면**
 * 발주서 작업이 실행시간 한도에 걸리거나 주문확인 버튼이 멈춘다. 계측은 best-effort 라
 * 상한을 넘기면 버리는 쪽이 옳다.
 */
const USAGE_WRITE_TIMEOUT_MS = 3000;

/** 계측 쓰기를 상한 안에서만 기다린다 — 초과분은 버리고(로그만) 호출부를 풀어준다. */
async function withWriteTimeout(label: string, write: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`계측 쓰기 ${USAGE_WRITE_TIMEOUT_MS}ms 초과`)), USAGE_WRITE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(`[naver-api-usage] ${label} 기록 실패(대상 작업은 영향 없음):`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * **종국** 실패 1건 = `ApiCallLog` 1행. 재시도로 이어지는 401·429 는 여기 오지 않고
 * tally 카운터(`tokenRefreshes`·`rateLimitRetries`)로만 센다 — 위 볼륨 규율 참조.
 * `retrying` 인자는 그 계약을 호출부에서 읽히게 남겨둔 것이고, true 로 부르지 말 것.
 */
export async function recordNaverCallFailure(params: {
  endpointLabel: string;
  method: string;
  statusCode: number;
  message: unknown;
  /** 재시도로 이어지는 실패(429·401)인가 — false 면 이 호출은 여기서 끝났다. */
  retrying: boolean;
  attempt: number;
  maxAttempts: number;
}): Promise<void> {
  const { endpointLabel, method, statusCode, message, retrying, attempt, maxAttempts } = params;
  await withWriteTimeout('호출 실패', () =>
    getPrisma().apiCallLog.create({
      data: {
        provider: NAVER_API_PROVIDER,
        permissionScope: NAVER_CALL_FAILURE_SCOPE,
        endpoint: endpointLabel,
        statusCode,
        success: false,
        errorMessage: truncateReason(message),
        metadata: JSON.stringify({ method, retrying, attempt, maxAttempts }),
      },
    }),
  );
}

/**
 * 오퍼레이션 1회 = `ApiCallLog` 1행. 최적화 전후 비교의 정본 지표다.
 *
 * `statusCode` 는 HTTP 상태가 아니라 **요약 행 표시값**이다(성공 200 / 실패 500) —
 * 이 행은 개별 호출이 아니라 집계라, 진짜 상태코드는 실패 행에 남는다.
 */
export async function recordNaverOperationUsage(params: {
  operation: NaverOperation;
  /** 이 오퍼레이션의 주 엔드포인트 라벨(분해는 metadata 의 byEndpoint 가 담당). */
  endpointLabel: string;
  tally: NaverCallTally;
  success: boolean;
  elapsedMs: number;
  errorMessage?: unknown;
  /** 비식별 컨텍스트만(캠페인 id 등). 셀러 실명·구매자 정보·실측 매출 금지(P0). */
  context?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const { operation, endpointLabel, tally, success, elapsedMs, errorMessage, context } = params;
  await withWriteTimeout('오퍼레이션', () =>
    getPrisma().apiCallLog.create({
      data: {
        provider: NAVER_API_PROVIDER,
        permissionScope: naverOpScope(operation),
        endpoint: endpointLabel,
        statusCode: success ? 200 : 500,
        success,
        errorMessage: errorMessage === undefined ? null : truncateReason(errorMessage),
        metadata: JSON.stringify({
          operation,
          logicalCalls: tally.logicalCalls,
          httpAttempts: tally.httpAttempts,
          rateLimitRetries: tally.rateLimitRetries,
          tokenRefreshes: tally.tokenRefreshes,
          skipped: tally.skipped,
          elapsedMs: Math.round(elapsedMs),
          byEndpoint: tally.httpAttemptsByEndpoint,
          ...(context ?? {}),
        }),
      },
    }),
  );
}
