import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { recordProxyRequest } from './proxy-usage';

/**
 * 프록시 에이전트 캐시.
 *
 * ⛔ **`new ProxyAgent(...)` 를 요청마다 만들지 말 것.** undici 의 ProxyAgent 는
 * 내부 풀에 CONNECT 터널을 유지해 여러 HTTP 요청이 한 터널을 재사용하게 한다.
 * 호출마다 새 인스턴스를 만들면 그 재사용이 구조적으로 0이 되어
 * **HTTP 요청 1건 = 프록시 터널 1건**이 된다(실측: 요청 5건 → 터널 5개,
 * 에이전트를 공유하면 1개). 프록시 요금제는 이 터널 수를 사용량으로 세므로
 * 그 차이가 그대로 청구·한도가 된다. 게다가 만든 에이전트를 닫지 않아
 * 소켓도 함께 샜다.
 *
 * `globalThis` 에 두는 이유는 `naver-commerce-api.ts` 의 TTL 캐시와 같다 —
 * 이 모듈이 서로 다른 라우트 번들에서 import 되어 모듈 인스턴스가 갈릴 수 있다.
 */
const AGENT_CACHE_KEY = '__wagProxyAgentCache';

function getProxyAgent(proxyUrl: string): ProxyAgent {
  const store = globalThis as unknown as Record<string, Map<string, ProxyAgent> | undefined>;
  let cache = store[AGENT_CACHE_KEY];
  if (!cache) {
    cache = new Map<string, ProxyAgent>();
    store[AGENT_CACHE_KEY] = cache;
  }

  let agent = cache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxyUrl,
      // ── 터널 유휴 재사용 창은 **오리진의 힌트**가 정한다 ─────────────────────────
      // `api.commerce.naver.com` 은 HTTP/1.1 로 `keep-alive: timeout=3` 을 보낸다
      // (curl 실측 2026-09-28). undici 는 그 힌트가 있으면
      //   min(힌트 − keepAliveTimeoutThreshold, keepAliveMaxTimeout)
      // 을 유휴 창으로 쓴다(undici `client-h1.js`(경로 문자열은 죽은 발송기 계약 테스트의 금지 패턴에 걸려 생략) 의 `parseKeepAliveTimeout`
      // 호출부, threshold 기본 2000ms 는 `client.js`). 즉 기본값으로는 3s − 2s = **1초**
      // 뒤 소켓을 스스로 닫고, 다음 호출은 CONNECT 를 새로 뚫는다. 프록시(Fixie)는
      // HTTP 요청이 아니라 **CONNECT 터널 1건 = 사용량 1**로 센다(오너 실측 2026-09-28:
      // 0.3초 간격 요청 2건 → 로그 1행). 로컬 계수 프록시 + 이 `proxyFetch` 실측:
      // 간격 0.5s → 3요청에 터널 1개 / 2.5s → 2개 / 3s·5s → 3개.
      //
      // threshold 를 1초로 내리면 창이 3s − 1s = **2초**가 된다. 한 액션(변경분 피드 →
      // product-orders/query 청크 → …)은 DB 작업 몇백 ms 를 사이에 둔 순차 호출 사슬이라
      // 그 사슬이 터널 하나를 타게 하는 것이 이 레버다(ProxyRequestDaily 실측: 화면 사용이
      // 몰린 날 이 세 사슬이 하루 요청의 절반을 넘겼다 — 수치는 로컬 핸드오프).
      // ⛔ 1초보다 더 내리지 말 것 — 서버가 3초에 끊는데 그 직전에 쓴 요청은 실패하고,
      //    POST 본문(주문확인·발주요청)은 아래 `proxyFetch` 가 재시도하지 않는다(GET 한정).
      //    1초는 그 경계 앞의 여유다.
      keepAliveTimeoutThreshold: 1_000,
      // ── 오리진당 연결 1개 ─────────────────────────────────────────────────────────
      // 동시 호출(`naver-commerce-client.ts` 의 p-queue concurrency 3 ·
      // `naver-order-sync.runFullSync` 의 일자별 `Promise.all`)은 기본 풀에서는 **각자
      // 터널을 하나씩** 연다 — Fixie 는 그 터널 수를 세므로 동시성이 곧 사용량이었다.
      // `connections: 1` 이면 undici 가 오리진당 `Client`(단일 연결) 를 써서 동시 요청이
      // 그 한 터널에 **직렬**로 실린다. 대가는 지연이다: N 일치 전체 동기화가 병렬에서
      // 순차로 바뀐다. 요금이 터널 수에 붙는 한 그 교환이 이 옵션의 목적이다.
      connections: 1,
      // ── 요청별 상한 — `connections: 1` 이 들여온 새 실패 모드의 방벽 ──────────────
      // 연결이 하나면 응답이 멎은 요청 하나가 **뒤의 모든 네이버 호출을 막는다**(종전에는
      // p-queue concurrency 3 이 각자 터널로 빠져나갔다). 그런데 호출부
      // (`naver-commerce-client.ts` · `naver-commerce-api.ts`)는 요청별 timeout 도
      // AbortSignal 도 걸지 않고(grep 확인 2026-09-28), undici 기본 `headersTimeout` ·
      // `bodyTimeout` 은 300s 다 — 멎은 응답 하나가 최대 5분 동안 줄 전체를 세운다.
      // 두 값은 Agent → factory 를 거쳐 오리진별 Client 에 그대로 전달된다(`connections` 과
      // 같은 경로).
      // 수치 근거: 네이버 응답은 통상 1초 미만이라 헤더 30s 는 그 30배 이상이고, Fixie
      // 로그에서 관측된 가장 큰 터널도 수 MB 수준의 정산/주문 페이지였다 — 본문 60s 는 그것을
      // 넉넉히 덮는다.
      // 만료는 **오류로 호출자에게 그대로 올라간다**(여기서 삼키지 않는다). 아래
      // `shouldRetrySameProxy` 는 거부 목록이라 `UND_ERR_HEADERS_TIMEOUT` ·
      // `UND_ERR_BODY_TIMEOUT` 도 GET·HEAD 면 같은 프록시로 1회 재시도된다(별도 매칭 없이
      // 이미 걸린다). POST 는 재시도되지 않고 그대로 던져진다 — ⛔ 그 술어를 넓히지 말 것.
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
      // ── 힌트가 없을 때만 쓰이는 기본 유휴 창 ────────────────────────────────────
      // 위 계산은 오리진이 `Keep-Alive` 힌트를 **보낼 때**의 것이고, 이 값은 힌트가
      // 없는 응답에만 쓰인다(`client-h1.js` 의 else 분기 → `kKeepAliveDefaultTimeout`).
      // 네이버는 항상 힌트를 보내므로 그 경로에서는 **아무것도 바꾸지 않는다** —
      // #47(2026-09-09) 이 이 값을 4s → 15s 로 키운 것은 그 이유로 효과가 0 이었다.
      // 힌트 없는 오리진(다른 프록시 경유 호출)을 위해 남겨 둔다.
      // ⛔ 이 위험은 `Keep-Alive` 헤더로 협상되지 않는다 — 그 헤더는 터널 **건너편
      //    오리진**이 보내는 것이고, **프록시**가 터널을 끊는 것은 아무 힌트도 없는 TCP
      //    이벤트다. 두 기전을 섞어 읽지 말 것. 죽은 소켓을 집었을 때의 완화는 아래
      //    `proxyFetch` 의 **동일 프록시 1회 재시도**가 담당한다(GET·HEAD 한정).
      // (`keepAliveMaxTimeout` 은 지정하지 않는다 — undici 기본값 600s 와 같아서
      //  적으면 튜닝한 것처럼 읽히지만 아무것도 바꾸지 않는다.)
      keepAliveTimeout: 15_000,
    });
    cache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * 오류와 그 `cause` 사슬(및 `AggregateError.errors`)의 메시지를 한 문자열로 모은다.
 * `AggregateError` 를 함께 보는 이유: 그쪽은 `cause` 가 아니라 `errors` 배열에 원인을
 * 담아, 사슬만 훑으면 놓친다 — 그리고 놓치면 **재시도를 허용하는 쪽**으로 틀린다.
 */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  // 폭 상한 — `AggregateError.errors` 는 개수 제한이 없어(happy-eyeballs 등) 이 문자열이
  // 곧 `console.warn` 한 줄이 되면 로그가 통째로 묻힌다. 판별에는 앞쪽이면 충분하다.
  const MAX_PARTS = 8;
  const walk = (cur: unknown, depth: number) => {
    if (!cur || depth > 4 || seen.has(cur) || parts.length >= MAX_PARTS) return;
    seen.add(cur);
    parts.push(String((cur as { message?: unknown }).message ?? cur));
    walk((cur as { cause?: unknown }).cause, depth + 1);
    const nested = (cur as { errors?: unknown }).errors;
    if (Array.isArray(nested)) for (const e of nested) walk(e, depth + 1);
  };
  walk(err, 0);
  return parts.join(' | ');
}

/**
 * 같은 프록시로 **1회만** 다시 보낼 실패인가.
 *
 * 노리는 것은 재사용하려던 터널이 이미 죽어 있던 경우(프록시가 우리보다 먼저 끊음)다.
 * ⚠️ 다만 이 술어는 **거부 목록이지 허용 목록이 아니다** — "죽은 소켓의 모양"을 골라
 * 내는 대신, 다시 보내면 안 되는 것을 빼고 나머지를 재시도한다. 그래서 DNS 실패·
 * ECONNREFUSED·TLS 오류도 1회 더 시도한다. 허용 목록으로 짜지 않은 이유는 undici 의
 * 소켓 오류 모양이 여럿이라(`other side closed` · `socket hang up` · `UND_ERR_SOCKET` …)
 * **하나라도 빠뜨리면 이 장치가 조용히 무력해지기** 때문이다.
 * 그 대가는 실패 종류마다 다르다: 프록시에 닿지도 못한 실패(DNS·연결 거부)는 CONNECT 가
 * 나가지 않아 프록시 요청 수를 늘리지 않지만, **터널이 뚫린 뒤의 실패(오리진 TLS 등)는
 * CONNECT 를 이미 썼으므로 재시도가 한 건을 더 태운다.** 대가를 0 으로 적지 말 것.
 *
 * ⛔ **GET·HEAD 만 재시도한다.** 연결이 끊겼을 때 요청이 서버에 닿았는지 알 수 없는데,
 * 이 경로에는 네이버 주문확인·발주요청처럼 **되돌릴 수 없는 부수효과** 호출이 함께 흐른다
 * (`naver-commerce-client.apiRequest`). 응답을 못 받은 POST 를 다시 보내면 같은 주문이
 * 두 번 나갈 수 있고, 그 피해는 터널 재사용이 아끼는 것보다 훨씬 크다.
 * ⚠️ **이 기준은 필요보다 넓게 배제한다** — `product-orders/query`(주문 조회)와 토큰 발급은
 * POST 지만 부수효과가 없다. 그런데 이 계층에는 그것을 가릴 수단이 없다(URL 을 알아보는
 * 것은 계층 침범이다). 넓히려면 **호출부가 안전하다고 선언**하는 통로를 먼저 만들 것 —
 * ⛔ 여기에서 메서드 목록만 늘리지 말 것.
 */
function shouldRetrySameProxy(
  err: unknown,
  options: { method?: string; signal?: { aborted?: boolean } },
): boolean {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  // 호출자가 이미 포기했다(예: `AbortSignal.timeout`). 같은 signal 로 다시 보내면
  // 즉시 같은 자리에서 죽으므로 재시도가 아니라 낭비다.
  if (options.signal?.aborted) return false;

  // 프록시가 CONNECT 에 200 이 아닌 응답을 줬다 — 죽은 소켓이 아니라 **프록시가 답을 한**
  // 경우다. 다시 보내면 프록시 요청만 한 번 더 태우고 폴백을 늦춘다 — 사용량을 줄이려는
  // 이 변경이 정확히 실패 구간에서 사용량을 두 배로 태운다.
  // ⚠️ 상태코드를 가리지 않는다: 대표 사례는 한도 소진의 **407** 이지만 502·504 같은
  //    일시적 거절도 함께 걸린다. 그쪽은 재시도가 유효할 수도 있으나, 어차피 다음
  //    프록시로 즉시 넘어가므로(폴백) 안전한 쪽이다. 문구는 undici 의
  //    `proxy-agent.js` 가 던지는 것이고, 계약 테스트가 그 실물과 대조한다.
  if (/Proxy response \(\d+\)/.test(errorChainText(err))) return false;

  return true;
}

export async function proxyFetch(url: string, options: any = {}) {
  const proxyUrlsStr = process.env.PROXY_URLS || process.env.FIXIE_URLS || process.env.FIXIE_URL;
  if (!proxyUrlsStr) {
    return undiciFetch(url, options);
  }

  const urls = proxyUrlsStr.split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return undiciFetch(url, options);
  }

  // 첫 번째 URL을 메인(Primary)으로, 이후 URL들을 서브(Fallback)로 사용합니다.
  for (let i = 0; i < urls.length; i++) {
    const proxyUrl = urls[i];
    // 터널 재사용이 들여온 실패 모드(위 `keepAliveTimeout` 주석)를 같은 프록시로
    // 1회 다시 시도해 흡수한다. undici 는 죽은 소켓을 풀에서 걷어내므로 재시도는
    // 새 터널로 나가리라 **기대**한다 — 이 계층에서 소켓 풀을 관찰할 수는 없다.
    let retriedThisProxy = false;

    for (;;) {
      try {
        options.dispatcher = getProxyAgent(proxyUrl);
        const res = await undiciFetch(url, options);
        // 프록시로 보낸 시도 1회 = 경로별 일 집계 1(재시도·폴백도 각각). 기다리지 않는다(proxy-usage.ts).
        recordProxyRequest({ url, failed: false });

        // 403(IP 차단), 429(할당량 초과), 50x(서버 에러) 발생 시 다음 프록시(서브)로 폴백
        // (프록시 한도 소진의 407 은 여기로 오지 않는다 — CONNECT 가 실패해 아래 catch 로 온다.)
        if (!res.ok && (res.status === 403 || res.status === 429 || res.status >= 500)) {
           if (i < urls.length - 1) {
               console.warn(`Proxy [${i}] returned ${res.status}. Falling back to next proxy...`);
               break; // 다음 프록시 시도
           }
        }
        return res;
      } catch (err: any) {
        recordProxyRequest({ url, failed: true });
        if (!retriedThisProxy && shouldRetrySameProxy(err, options)) {
          retriedThisProxy = true;
          console.warn(`Proxy [${i}] connection failed: ${errorChainText(err)}. Retrying same proxy once...`);
          continue; // 같은 프록시로 1회 재시도
        }
        if (i === urls.length - 1) {
          throw err; // 마지막 프록시까지 실패하면 에러 반환
        }
        console.warn(`Proxy [${i}] fetch failed: ${errorChainText(err)}. Retrying with next proxy...`);
        break; // 다음 프록시 시도
      }
    }
  }

  throw new Error("All proxies failed");
}
