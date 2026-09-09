import { fetch as undiciFetch, ProxyAgent } from 'undici';

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
      // 크론 1회 실행 안에서도 호출 간격이 3~4초까지 벌어진다(정산 동기화 실측).
      // undici 기본 유휴 타임아웃 4초는 그 틈에 딱 걸쳐 있어 재사용이 자주 깨지므로
      // 약 4배 여유를 둔다.
      //
      // ⚠️ **이 값을 키우는 것은 공짜가 아니다.** 유휴 소켓을 오래 들고 있을수록,
      // 프록시가 우리보다 먼저 그 터널을 끊었을 때 **이미 죽은 소켓을 집을 창**이
      // 넓어진다. 그건 호출마다 새 소켓을 열던 종전에는 **없던 실패 모드**다.
      // ⛔ 이 위험은 `Keep-Alive` 헤더로 협상되지 않는다 — 그 헤더는 터널 **건너편
      //    오리진**(네이버)이 보내는 것이고, 프록시가 터널을 끊는 것은 아무 힌트도
      //    없는 TCP 이벤트다. 두 기전을 섞어 읽지 말 것.
      // 완화는 아래 `proxyFetch` 의 **동일 프록시 1회 재시도**가 담당한다(GET 한정).
      // ⛔ 15초 자체도 이 프록시의 실 유휴 타임아웃과 대조된 적이 없다(한도 소진으로
      //    측정 불가). 문제가 보이면 **키우지 말고 undici 기본값 쪽으로 낮출 것.**
      // (`keepAliveMaxTimeout` 은 지정하지 않는다 — undici 기본값 600s 와 같아서
      //  적으면 튜닝한 것처럼 읽히지만 아무것도 바꾸지 않는다.)
      keepAliveTimeout: 15_000,
    });
    cache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * 같은 프록시로 다시 보내도 안전한 요청인가.
 *
 * ⛔ **GET·HEAD 만 재시도한다.** 연결이 끊겼을 때 요청이 서버에 닿았는지는 알 수 없는데,
 * 이 경로에는 네이버 주문확인·발주요청처럼 **되돌릴 수 없는 부수효과** 호출이 함께 흐른다
 * (`naver-commerce-client.apiRequest`). 응답을 못 받은 POST 를 다시 보내면 같은 주문이
 * 두 번 나갈 수 있고, 그 피해는 터널 재사용이 아끼는 것보다 훨씬 크다.
 * ⛔ 여기에 POST 를 추가하지 말 것 — 부수효과 호출부를 전수로 가려낸 뒤에야 논의할 수 있다.
 */
function isRetriableRequest(options: { method?: string }): boolean {
  const method = (options?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
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
    // 1회 다시 시도해 흡수한다 — undici 가 죽은 소켓을 풀에서 걷어낸 뒤이므로
    // 재시도는 새 터널로 나간다.
    const maxAttempts = isRetriableRequest(options) ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options.dispatcher = getProxyAgent(proxyUrl);
        const res = await undiciFetch(url, options);

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
        if (attempt < maxAttempts) {
          console.warn(`Proxy [${i}] connection failed: ${err.message}. Retrying same proxy once...`);
          continue; // 같은 프록시로 1회 재시도
        }
        if (i === urls.length - 1) {
          throw err; // 마지막 프록시까지 실패하면 에러 반환
        }
        console.warn(`Proxy [${i}] fetch failed: ${err.message}. Retrying with next proxy...`);
      }
    }
  }

  throw new Error("All proxies failed");
}
