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
      // undici 기본 유휴 타임아웃(4초)으로는 그 틈에 터널이 끊겨 재사용이 깨지므로
      // 잡 하나가 끝날 때까지 살아 있도록 넉넉히 잡는다.
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 10 * 60_000,
    });
    cache.set(proxyUrl, agent);
  }
  return agent;
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
    try {
      options.dispatcher = getProxyAgent(proxyUrl);
      const res = await undiciFetch(url, options);

      // 403(IP 차단), 429(할당량 초과), 50x(서버 에러) 발생 시 다음 프록시(서브)로 폴백
      if (!res.ok && (res.status === 403 || res.status === 429 || res.status >= 500)) {
         if (i < urls.length - 1) {
             console.warn(`Proxy [${i}] returned ${res.status}. Falling back to next proxy...`);
             continue; // 다음 프록시 시도
         }
      }
      return res;
    } catch (err: any) {
      if (i === urls.length - 1) {
        throw err; // 마지막 프록시까지 실패하면 에러 반환
      }
      console.warn(`Proxy [${i}] fetch failed: ${err.message}. Retrying with next proxy...`);
    }
  }

  throw new Error("All proxies failed");
}
