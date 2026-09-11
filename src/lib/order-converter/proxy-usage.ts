import { AsyncLocalStorage } from 'node:async_hooks';
import { getPrisma } from '@/lib/prisma';
import { toKstYmd } from '@/lib/date-utils';

/**
 * 프록시(Fixie) 요청 수의 **경로별 일 집계** — `ProxyRequestDaily` 1행 = (KST 날짜 · 누가 · 어디로).
 *
 * 왜 필요한가: 프록시 요금제는 월 요청 수로 한도가 걸리는데(한도 소진 = 407 로 네이버 크론 전면 정지 전례),
 * 지금까지 그 요청이 **어느 경로에서 나갔는지 셀 수단이 없었다**. `naver-api-usage.ts` 는 운영자가 누른
 * 작업의 요약과 종국 실패만 남기고(P7 볼륨 규율), 동기화·상품검색·토큰 발급·그리고 **네이버가 아닌
 * 프록시 사용처**(인스타 수집·레퍼런스 보강 등 — 같은 `proxyFetch` 를 쓴다)는 전혀 세지 않았다.
 *
 * 무엇을 세는가: `proxyFetch` 가 프록시로 **보낸 시도 1회 = 1**(같은 프록시 재시도·다음 프록시 폴백도
 * 각각 1). 프록시가 없는 환경(로컬·데모)은 세지 않는다 — 한도와 무관하다.
 * ⚠️ 프록시 사업자 수치와는 두 방향으로 어긋난다 — 결함으로 조사하기 전에 둘 다 볼 것:
 *    - **이 합계가 더 큰 쪽:** 사업자는 CONNECT 터널 수를 세고 터널은 유휴 15초 안에서 여러 요청이
 *      재사용한다(`fetch-client.ts`). 또 프록시에 닿기 전에 끝난 실패(DNS·연결 거부)도 여기선 1로 센다.
 *    - **사업자가 더 큰 쪽:** `proxyFetch` 를 거치지 않는 프록시 사용처는 안 센다 — 리뷰 수집
 *      (`naver-review-scrape.ts`)이 같은 프록시 설정을 브라우저에 넘긴다(수동 실행 시에만 돈다).
 *    - 비교는 **월 합계**로 한다 — 사업자 화면은 월 누계이고 여기는 KST 날짜별이다.
 *
 * 볼륨: 요청마다 행을 만들지 않고 (날짜·source·target) 행의 카운터를 올린다 — 하루 행 수는 경로 수만큼.
 * 쓰기도 요청마다 하지 않는다 — 메모리에 모았다가 짧은 간격으로 한 번에 쓴다(인스타 수집처럼 요청이
 * 몰리면 같은 행에 대한 쓰기가 줄지어 DB 연결을 붙잡는다). 대가: 프로세스가 그 사이에 죽으면 몇 초치
 * 카운트를 잃는다 — 한도 파악용 집계라 감수한다.
 * ⛔ `ApiCallLog` 에 넣지 말 것 — 그 표는 provider 무관 최근 20행을 UI 3곳이 읽어, 고볼륨 행이
 *    들어가면 Meta 증빙 표가 무너진다(P7 「Naver Call Observability」).
 *
 * ⚠️ 시크릿·PII 금지(P0, 레포 PUBLIC): target 은 **호스트(+네이버는 경로 묶음)** 만 담는다 — 경로의 id·
 *    쿼리 문자열·토큰은 버린다. source 는 아래 목록의 코드 라벨뿐이다.
 *
 * 기록은 요청을 기다리게 하지 않고 **절대 throw 하지 않는다** — 실패는 console.error 로만 표면화한다
 * (계측이 네이버 호출을 깨면 안 된다).
 */

/** 누가 불렀는지 모를 때의 source. 이 값이 크면 라벨이 빠진 경로가 있다는 뜻이다. */
export const UNLABELED_PROXY_SOURCE = 'unlabeled';

/**
 * 프록시 요청을 보내는 경로 라벨. 문자열 오타가 조용히 새 행을 만들지 않게 목록으로 묶는다.
 * 크론은 `withSystemTaskStatus` 가 `cron:<작업 키>` 로 자동으로 붙인다.
 */
export type ProxySource =
  | `cron:${string}`
  | 'entry-sync' // 화면 진입(주문관리·셀러 포털 등) 백그라운드 변경피드 동기화
  | 'delivering-sweep' // 화면 진입 시 배송중 → 배송완료 보정
  | 'bootstrap-sync' // 스냅샷이 전혀 없을 때의 최초 전체 동기화
  | 'manual-sync' // 주문관리 새로고침 버튼
  | 'mobile-sync' // 모바일 당겨서 새로고침
  | 'dispatch' // 송장 등록(발송처리)
  | 'delay-dispatch' // 발송지연 처리
  | 'order-execute' // 주문확인·발주서
  | 'campaign-update' // 캠페인 저장·마감(마감 주문 스냅샷 조회 포함)
  | 'campaign-reopen' // 마감 취소
  | 'product-search' // 스토어 상품 목록(60초 쿨다운)
  | 'product-options' // 상품 옵션 조회
  | 'claims' // 반품·교환 목록의 반품 택배사 조회
  | 'admin-recalc' // 마감 캠페인 캐시 재계산(관리자)
  | typeof UNLABELED_PROXY_SOURCE;

const sourceStore = new AsyncLocalStorage<ProxySource>();

/**
 * 이 안에서 나가는 프록시 요청을 `source` 로 센다. 안쪽 라벨이 바깥 라벨을 이긴다
 * (예: 크론 안의 상품검색은 `product-search`).
 * ⚠️ 비동기 작업은 `fn` 안에서 **시작**돼야 라벨을 물려받는다 — 밖에서 만든 Promise 를 안에서
 *    await 해도 그 작업의 요청은 바깥 라벨로 센다. `runSync` 처럼 진행 중인 작업을 공유하는 곳은
 *    **먼저 시작한 쪽** 라벨로 센다(뒤에 합류한 쪽은 요청을 보내지 않으므로 그게 맞다).
 */
export function runWithProxySource<T>(source: ProxySource, fn: () => T): T {
  return sourceStore.run(source, fn);
}

/** 라우트 핸들러를 통째로 `source` 라벨 안에서 돌린다 — `export const GET = withProxySource(...)`. */
export function withProxySource<A extends unknown[], R>(
  source: ProxySource,
  handler: (...args: A) => R,
): (...args: A) => R {
  return (...args: A) => runWithProxySource(source, () => handler(...args));
}

export function getProxySource(): ProxySource {
  return sourceStore.getStore() ?? UNLABELED_PROXY_SOURCE;
}

const NAVER_COMMERCE_HOST = 'api.commerce.naver.com';

/**
 * 요청 URL → 집계 target. 네이버 커머스는 경로를 묶음으로(어떤 API 가 한도를 먹는지 보이게),
 * 그 밖은 호스트만 남긴다. 경로의 id·쿼리는 절대 담지 않는다(P0).
 */
export function proxyTargetLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid-url';
  }
  if (parsed.hostname !== NAVER_COMMERCE_HOST) return parsed.hostname || 'invalid-url';
  const path = parsed.pathname;
  if (path.includes('/oauth2/token')) return 'naver:token';
  if (path.includes('/pay-order/')) return 'naver:order';
  if (path.includes('/pay-settle/')) return 'naver:settlement';
  if (path.includes('/products')) return 'naver:product';
  if (path.includes('/qnas') || path.includes('/inquiries')) return 'naver:qna';
  return 'naver:other';
}

// ============================================================================
// 메모리 적재 → 짧은 간격으로 한 번에 쓰기
// ============================================================================

/** 쓰기 간격(ms). 요청이 몰리는 구간을 한 행 쓰기로 접는다. */
export const PROXY_USAGE_FLUSH_DELAY_MS = 2000;

interface PendingCount {
  day: string;
  source: ProxySource;
  target: string;
  requests: number;
  failures: number;
}

const PENDING_KEY = '__wagProxyUsagePending';
const TIMER_KEY = '__wagProxyUsageFlushTimer';

/** 라우트 번들마다 모듈 인스턴스가 갈릴 수 있어 globalThis 에 둔다(`fetch-client.ts` 에이전트 캐시와 같은 이유). */
function pendingStore(): Map<string, PendingCount> {
  const g = globalThis as unknown as Record<string, Map<string, PendingCount> | undefined>;
  let pending = g[PENDING_KEY];
  if (!pending) {
    pending = new Map();
    g[PENDING_KEY] = pending;
  }
  return pending;
}

/**
 * 프록시로 보낸 시도 1회를 센다. `failed` 는 응답을 못 받고 예외로 끝난 시도다(프록시 거절 407 포함 —
 * 그 시도가 한도를 먹었는지는 이 계층에서 알 수 없다). 기다리지 않는다.
 */
export function recordProxyRequest(input: { url: string; failed: boolean; nowMs?: number }): void {
  const day = toKstYmd(new Date(input.nowMs ?? Date.now()));
  const source = getProxySource();
  const target = proxyTargetLabel(input.url);
  const key = `${day}|${source}|${target}`;
  const pending = pendingStore();
  const entry = pending.get(key) ?? { day, source, target, requests: 0, failures: 0 };
  entry.requests += 1;
  if (input.failed) entry.failures += 1;
  pending.set(key, entry);
  scheduleFlush();
}

function scheduleFlush(): void {
  const g = globalThis as unknown as Record<string, ReturnType<typeof setTimeout> | undefined>;
  if (g[TIMER_KEY]) return;
  const timer = setTimeout(() => {
    g[TIMER_KEY] = undefined;
    void flushProxyRequestCounts();
  }, PROXY_USAGE_FLUSH_DELAY_MS);
  // 이 타이머 때문에 프로세스(스크립트·테스트)가 종료를 미루지 않게 한다.
  (timer as { unref?: () => void }).unref?.();
  g[TIMER_KEY] = timer;
}

/** 모아 둔 카운트를 지금 쓴다. 실패한 행은 console.error 로 남기고 버린다(재적재하면 장애가 쌓인다). */
export async function flushProxyRequestCounts(): Promise<void> {
  const pending = pendingStore();
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  await Promise.all(
    batch.map((entry) =>
      incrementProxyRequestDaily(entry).catch((err) => {
        console.error('[proxy-usage] 프록시 요청 집계 기록 실패(대상 요청은 영향 없음):', err);
      }),
    ),
  );
}

/** (날짜·source·target) 행의 카운터를 올린다. 첫 삽입이 동시에 겹치면 한 번만 update 로 재시도한다. */
export async function incrementProxyRequestDaily(input: {
  day: string;
  source: ProxySource;
  target: string;
  requests: number;
  failures: number;
}): Promise<void> {
  const { day, source, target, requests, failures } = input;
  const prisma = getPrisma();
  const where = { day_source_target: { day, source, target } };
  const increment = {
    requests: { increment: requests },
    ...(failures > 0 ? { failures: { increment: failures } } : {}),
  };
  try {
    await prisma.proxyRequestDaily.upsert({
      where,
      create: { day, source, target, requests, failures },
      update: increment,
    });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'P2002') {
      await prisma.proxyRequestDaily.update({ where, data: increment });
      return;
    }
    throw err;
  }
}
