import bcrypt from 'bcrypt';
import PQueue from 'p-queue';
import { proxyFetch } from './fetch-client';
import {
  getNaverCallTally,
  noteNaverHttpAttempt,
  noteNaverRateLimitRetry,
  noteNaverTokenRefresh,
  recordNaverCallFailure,
  toNaverEndpointLabel,
} from './naver-api-usage';

const BASE_URL = 'https://api.commerce.naver.com/external';

// Global Queue configuration to avoid 429 Too Many Requests
const queue = new PQueue({ concurrency: 3, intervalCap: 8, interval: 1000 });

let cachedToken: string | null = null;
let tokenExpiresAt: number | null = null;

/**
 * bcrypt 기반 전자서명 생성
 */
function generateSignature(clientId: string, clientSecret: string, timestamp: number): string {
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hashed, 'utf-8').toString('base64');
}

let tokenPromise: Promise<string> | null = null;

/**
 * 인증 토큰 발급 (캐싱 적용)
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
  let CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';

  if (process.env.NAVER_CLIENT_SECRET_BASE64) {
    try {
      CLIENT_SECRET = Buffer.from(process.env.NAVER_CLIENT_SECRET_BASE64, 'base64').toString('utf-8').trim();
    } catch (e) {
      console.error('Failed to decode NAVER_CLIENT_SECRET_BASE64', e);
    }
  } else if (CLIENT_SECRET.startsWith('$$')) {
    CLIENT_SECRET = CLIENT_SECRET.replace(/\$\$/g, '$').trim();
  } else {
    CLIENT_SECRET = CLIENT_SECRET.trim();
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(`NAVER_CLIENT_ID or NAVER_CLIENT_SECRET is not set in environment variables. CLIENT_ID Length=${CLIENT_ID.length}, CLIENT_SECRET Length=${CLIENT_SECRET.length}`);
  }

  const now = Date.now();

  // 토큰이 캐시되어 있고 유효기간이 1분 이상 남았으면 재사용
  if (!forceRefresh && cachedToken && tokenExpiresAt && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  // 이미 진행 중인 토큰 발급 요청이 있다면 해당 Promise를 반환 (병렬 요청 방지)
  if (!forceRefresh && tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    try {
      const timestamp = Date.now();
      const signature = generateSignature(CLIENT_ID, CLIENT_SECRET, timestamp);

      const payload = {
        client_id: CLIENT_ID,
        timestamp,
        grant_type: 'client_credentials',
        client_secret_sign: signature,
        type: 'SELF',
      };
      
      console.log('Sending token payload (deduplicated)...');

      const response = await proxyFetch(`${BASE_URL}/v1/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload as any).toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as any;
      
      cachedToken = data.access_token;
      // expires_in은 초 단위, Date.now()는 밀리초 단위
      tokenExpiresAt = Date.now() + (data.expires_in * 1000);

      return cachedToken as string;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

/**
 * 네이버 커머스 API 공통 요청 함수
 */
export async function apiRequest(method: string, path: string, body?: any, query?: Record<string, string>): Promise<any> {
  // 계측 컨텍스트는 **진입 시 동기적으로** 읽는다 — 아래 p-queue 가 실행을 지연시키므로
  // 큐 콜백 안에서 읽으면 AsyncLocalStorage 컨텍스트가 유실될 수 있다(naver-api-usage 주석).
  const tally = getNaverCallTally();
  const endpointLabel = toNaverEndpointLabel(path);

  return queue.add(async () => {
    let token = await getAccessToken();
  
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.append(key, value);
      }
    }
    url += `?${params.toString()}`;
  }

  let attempt = 0;
  const maxAttempts = 5; // 429를 대비해 넉넉하게 늘림

  while (attempt < maxAttempts) {
    attempt++;

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    };

    noteNaverHttpAttempt(tally, endpointLabel);
    const response = await proxyFetch(url, options);

    if (response.ok) {
      return await response.json();
    }

    const responseText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(responseText);
    } catch {
      errorData = { message: responseText };
    }

    // 401 Unauthorized (GW.AUTHN) 처리 - 토큰 만료
    if (response.status === 401 && errorData?.code === 'GW.AUTHN' && attempt < maxAttempts) {
      console.warn('Naver API token expired, refreshing...');
      // 토큰 만료 후 재발급은 **자기치유 정상 이벤트**다 — 실패 행으로 남기면 "NAVER 실패
      // 건수"가 구조적으로 0이 될 수 없어 실패율을 신호로 쓸 수 없게 된다. 카운터로만 센다.
      noteNaverTokenRefresh(tally);
      token = await getAccessToken(true);
      continue;
    }

    // 429 Too Many Requests (GW.RATE_LIMIT / GW.QUOTA_LIMIT) 처리
    if (response.status === 429 && attempt < maxAttempts) {
      const delayMs = 1000 * attempt; // 1s, 2s, 3s... (Exponential backoff 흉내)
      console.warn(`Naver API rate limited (429). Retrying in ${delayMs}ms... (Attempt ${attempt}/${maxAttempts})`);
      // 429 재시도분은 **행을 만들지 않고 카운터로만** 센다(요약 행의 rateLimitRetries).
      // 청크 19개 × 외부 2회 × 내부 4회 = 150행대가 되어 ApiCallLog 의 provider 무관
      // 최근 20행 창을 점거하고, 그러면 Meta App Review 증빙 표에서 Instagram 행이
      // 사라진다 — 이 계측이 막으려던 실패 모드 그 자체다. 되살리지 말 것.
      // 재시도가 끝내 실패하면 아래 "그 외 에러"가 종국 실패 1행을 남긴다.
      noteNaverRateLimitRetry(tally);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    // 그 외 에러
    await recordNaverCallFailure({
      endpointLabel, method, statusCode: response.status,
      message: errorData.message || responseText, retrying: false, attempt, maxAttempts,
    });
    throw new Error(`Naver API Error [${response.status}]: ${errorData.message || responseText}`);
  }

  // 여기는 도달하지 않는다: attempt === maxAttempts 가 되면 401·429 분기가 모두
  // `attempt < maxAttempts` 를 요구해 거짓이 되고, 위 "그 외 에러"가 종국 실패 1행을
  // 남기고 throw 한다. 따라서 재시도 소진 사례는 `429 + retrying:false` 행으로 찾는다
  // (`statusCode: 0` 행을 찾으면 영구히 0건이다). 안전망으로만 남긴다.
  throw new Error('Naver API request failed after max attempts');
  });
}

