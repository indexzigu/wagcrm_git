import bcrypt from 'bcrypt';
import { proxyFetch } from './fetch-client';
import {
  getNaverCallTally,
  noteNaverHttpAttempt,
  recordNaverCallFailure,
  toNaverEndpointLabel,
} from './naver-api-usage';

/**
 * ⚠️ 이 모듈은 `naver-commerce-client.ts` 의 `apiRequest` 와 **별개의 두 번째 네이버
 * 클라이언트**다(큐·429 재시도 없음). `searchNaverProducts` 는 대시보드 GET 에서
 * `needsResync` 일 때마다 호출된다(campaigns-handler) — 그래서 실패를 계측하지 않으면
 * `console.warn` 으로만 삼켜진다(P0). 성공 호출량은 P7 볼륨 규율에 따라 `ApiCallLog`
 * 행으로 남기지 않는다(naver-api-usage 헤더 주석 참조).
 */
const PRODUCTS_SEARCH_ENDPOINT = '/v1/products/search';

/**
 * 네이버 커머스 API 환경 변수 로드 및 이스케이프 해제
 */
function getNaverCredentials() {
  const clientId = process.env.NAVER_CLIENT_ID || '';
  let clientSecret = process.env.NAVER_CLIENT_SECRET || '';

  if (process.env.NAVER_CLIENT_SECRET_BASE64) {
    try {
      clientSecret = Buffer.from(process.env.NAVER_CLIENT_SECRET_BASE64, 'base64').toString('utf-8').trim();
    } catch (e) {
      console.error('Failed to decode NAVER_CLIENT_SECRET_BASE64', e);
    }
  } else if (clientSecret.startsWith('$$')) {
    clientSecret = clientSecret.replace(/\$\$/g, '$').trim();
  } else {
    clientSecret = clientSecret.trim();
  }

  return { clientId, clientSecret };
}

/**
 * 네이버 커머스 API 액세스 토큰 발급
 */
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

export async function getNaverToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const { clientId, clientSecret } = getNaverCredentials();
  
  if (!clientId || !clientSecret) {
    throw new Error(`Naver Credentials are not set. ID length: ${clientId.length}, Secret length: ${clientSecret.length}`);
  }

  const timestamp = Date.now();
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  const signature = Buffer.from(hashed, "utf-8").toString("base64");

  const response = await proxyFetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      timestamp: timestamp.toString(),
      grant_type: "client_credentials",
      client_secret_sign: signature,
      type: "SELF",
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Naver Token Error: ${err}`);
  }

  const data = (await response.json()) as any;
  cachedToken = data.access_token;
  // Naver token is usually valid for some time. We cache for 2 hours (7200 seconds)
  const expiresIn = data.expires_in ? parseInt(data.expires_in, 10) * 1000 : 2 * 60 * 60 * 1000;
  tokenExpiresAt = now + expiresIn - 60000; // 1 minute safety buffer
  
  return cachedToken;
}

/**
 * 상품 검색 결과 캐시 TTL(60초, 오너 결정 2026-07-30).
 *
 * 이 조회는 `campaigns-handler` 의 `needsNaver` 가 참인 동안 **대시보드 GET 1회당 1회**
 * 나간다(실측 2026-07-30, Sentry 스팬 30일: 총 776회 · 활성일 16~192회/일 · 비활성일 0회 —
 * 대시보드 GET 시계열과 활성일에 한 자리도 다르지 않다). 호출량 자체는 문제가 아니었고
 * (무료 API·429 없음·종국 실패 0건), **실제 비용은 지연**이었다: 이 호출이 GET 핸들러 안에서
 * 동기 await 되고 avg 751ms / p95 1356ms 라 대시보드 GET 평균(1735ms)의 약 43% 를 차지했다.
 *
 * TTL 이 60초여도 판매기간 연장 반영은 늦어지지 않는다 — 재동기화 창(`shouldResyncCampaignPeriod`)
 * 자체가 리드 2일 + 그레이스 7일짜리라, 60초는 그 창 안에서 무시 가능한 지연이다. 이 조회가
 * 존재하는 이유("스토어에서 기간이 연장됐는데 판매관리엔 없다"를 감지 — 58 vs 발주 78 실사고의 축)는
 * 그대로 유지된다. ⛔ TTL 을 재동기화 창에 근접한 크기로 키우지 말 것.
 */
const PRODUCTS_SEARCH_TTL_MS = 60 * 1000;

type ProductsSearchCacheEntry = { data: any; fetchedAt: number };

/**
 * 네이버 커머스 상품 목록 조회 — 60초 TTL 캐시 + in-flight dedupe.
 *
 * 상태를 모듈 전역 `let` 이 아니라 `globalThis` 에 두는 이유는 `runSync` 와 같다(같은 관용구):
 * 이 함수는 **서로 다른 라우트 번들 2곳**(campaigns-handler · `/api/naver/products`)에서
 * import 되고, Next 는 번들마다 모듈 인스턴스를 따로 줄 수 있다. 모듈 지역 변수로 두면
 * 두 경로가 각자 캐시를 들고 서로의 조회를 재사용하지 못한다.
 *
 * **실패는 캐시하지 않는다(부정 캐싱 없음).** 실패 시 다음 호출이 곧바로 재시도하므로 장애가
 * TTL 만큼 연장되지 않는다 — 그 구간의 동작은 이 변경 이전(쿨다운 없음)과 동일하므로 회귀가
 * 아니다. 실패 계측(`recordNaverCallFailure`)과 throw 계약도 그대로다.
 */
export async function searchNaverProducts(): Promise<any> {
  const g = global as any;

  const cached: ProductsSearchCacheEntry | undefined = g.__naverProductsSearchCache;
  if (cached && Date.now() - cached.fetchedAt < PRODUCTS_SEARCH_TTL_MS) {
    return cached.data;
  }

  // 동시 진입(대시보드 GET 이 겹치는 순간)은 같은 Promise 를 공유해 중복 왕복을 막는다.
  if (g.__naverProductsSearchInFlight) {
    return g.__naverProductsSearchInFlight as Promise<any>;
  }

  // ⚠️ IIFE 는 여기서 **동기적으로** 생성돼야 tally 의 AsyncLocalStorage 컨텍스트가 보존된다(P7).
  g.__naverProductsSearchInFlight = (async () => {
    try {
      const data = await fetchNaverProducts();
      g.__naverProductsSearchCache = { data, fetchedAt: Date.now() } satisfies ProductsSearchCacheEntry;
      return data;
    } finally {
      g.__naverProductsSearchInFlight = null;
    }
  })();

  return g.__naverProductsSearchInFlight;
}

/** 캐시를 우회하는 실제 조회. 호출량 계측(tally)은 실제 HTTP 시도가 있을 때만 올라간다. */
async function fetchNaverProducts(): Promise<any> {
  const tally = getNaverCallTally();
  const endpointLabel = toNaverEndpointLabel(PRODUCTS_SEARCH_ENDPOINT);
  const token = await getNaverToken();

  noteNaverHttpAttempt(tally, endpointLabel);
  const response = await proxyFetch("https://api.commerce.naver.com/external/v1/products/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      orderType: "NO", // 최근 등록순 등 정렬 파라미터 (스펙상 NO = No, 이름순? ID순? 등 정렬조건이나 최신 스펙 확인)
    })
  });

  if (!response.ok) {
    const err = await response.text();
    await recordNaverCallFailure({
      endpointLabel, method: 'POST', statusCode: response.status,
      message: err, retrying: false, attempt: 1, maxAttempts: 1,
    });
    throw new Error(`Naver Products Error: ${err}`);
  }

  const data = await response.json();
  return data;
}
