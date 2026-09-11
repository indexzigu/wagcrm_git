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
 * 무엇을 세는가: `proxyFetch` 가 프록시로 **실제 보낸 시도 1회 = 1**(같은 프록시 재시도·다음 프록시
 * 폴백도 각각 1). 프록시가 없는 환경(로컬·데모)은 세지 않는다 — 한도와 무관하다.
 * ⚠️ 프록시 사업자가 세는 수와는 원래 다르다: 사업자는 CONNECT 터널 수를 세고, 터널은 유휴 15초
 *    안에서 여러 요청이 재사용한다(`fetch-client.ts`). 그래서 이 합계는 사업자 수치보다 **크거나 같다**.
 *    둘의 차이가 곧 터널 재사용의 효과다 — 어긋난다고 계측 결함으로 조사하지 말 것.
 *
 * 볼륨: 요청마다 행을 만들지 않고 (날짜·source·target) 행의 카운터를 올린다 — 하루 행 수는 경로 수만큼.
 * ⛔ `ApiCallLog` 에 넣지 말 것 — 그 표는 provider 무관 최근 20행을 UI 3곳이 읽어, 고볼륨 행이
 *    들어가면 Meta 증빙 표가 무너진다(P7 「Naver Call Observability」).
 *
 * ⚠️ 시크릿·PII 금지(P0, 레포 PUBLIC): target 은 **호스트(+네이버는 경로 묶음)** 만 담는다 — 경로의 id·
 *    쿼리 문자열·토큰은 버린다. source 는 코드에 박힌 라벨뿐이다.
 *
 * 기록은 요청을 기다리게 하지 않고(fire-and-forget) **절대 throw 하지 않는다** — 실패는 console.error 로만
 * 표면화한다(계측이 네이버 호출을 깨면 안 된다).
 */

/** 누가 불렀는지 모를 때의 source. 이 값이 크면 라벨이 빠진 경로가 있다는 뜻이다. */
export const UNLABELED_PROXY_SOURCE = 'unlabeled';

const sourceStore = new AsyncLocalStorage<string>();

/**
 * 이 안에서 나가는 프록시 요청을 `source` 로 센다. 안쪽 라벨이 바깥 라벨을 이긴다
 * (예: 크론 안의 상품검색은 `product-search`).
 * ⚠️ 비동기 작업은 `fn` 안에서 **시작**돼야 라벨을 물려받는다 — 밖에서 만든 Promise 를 안에서
 *    await 해도 그 작업의 요청은 바깥 라벨로 센다.
 */
export function runWithProxySource<T>(source: string, fn: () => T): T {
  return sourceStore.run(source, fn);
}

export function getProxySource(): string {
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

/**
 * 프록시로 보낸 시도 1회를 센다. `failed` 는 응답을 못 받고 예외로 끝난 시도다(프록시 거절 407 포함 —
 * 그 시도가 한도를 먹었는지는 이 계층에서 알 수 없다). 기다리지 않는다.
 */
export function recordProxyRequest(input: { url: string; failed: boolean; nowMs?: number }): void {
  const day = toKstYmd(new Date(input.nowMs ?? Date.now()));
  const source = getProxySource();
  const target = proxyTargetLabel(input.url);
  void incrementProxyRequestDaily({ day, source, target, failed: input.failed }).catch((err) => {
    console.error('[proxy-usage] 프록시 요청 집계 기록 실패(대상 요청은 영향 없음):', err);
  });
}

/** (날짜·source·target) 행의 카운터를 1 올린다. 첫 삽입이 동시에 겹치면 한 번만 update 로 재시도한다. */
export async function incrementProxyRequestDaily(input: {
  day: string;
  source: string;
  target: string;
  failed: boolean;
}): Promise<void> {
  const { day, source, target, failed } = input;
  const prisma = getPrisma();
  const where = { day_source_target: { day, source, target } };
  const increment = { requests: { increment: 1 }, ...(failed ? { failures: { increment: 1 } } : {}) };
  try {
    await prisma.proxyRequestDaily.upsert({
      where,
      create: { day, source, target, requests: 1, failures: failed ? 1 : 0 },
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
