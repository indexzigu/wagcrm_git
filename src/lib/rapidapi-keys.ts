/**
 * RapidAPI 키 풀 + 쿼터 소진 시 다음 키로 넘어가는 fetch 래퍼.
 *
 * 배경(2026-07-23 오너): 무료 플랜 쿼터를 확보하려고 계정 3개를 돌려 쓴다.
 * 기존 `getRapidApiKey()` 는 모듈 전역 `keyIndex` 라운드로빈이었는데, 서버리스에서는
 * 인스턴스마다 인덱스가 0으로 초기화돼 **사실상 첫 키만 태우고 나머지가 놀았다**.
 * 게다가 429(쿼터 소진)를 감지해 넘어가는 로직이 없어, 소진되면 그냥 실패했다.
 *
 * 그래서 정책을 **순차 소진(sequential drain)** 으로 바꾼다 — keys[0] 을 쓰다가
 * 쿼터가 차면 keys[1], 그다음 keys[2]. 상태를 안 들고 있으므로 서버리스에서도
 * 의도대로 동작한다. 429·403 응답은 쿼터를 소모하지 않으므로, 앞 키가 소진된 뒤의
 * 비용은 왕복 한 번의 지연뿐이다.
 *
 * ⚠️ 키마다 구독한 API 가 다르다. 이 풀은 **세 키가 모두 구독한 엔드포인트**
 * (인스타 `instagram-scraper-20251`)에만 쓸 것. X 조회처럼 한 키에만 구독이 붙은
 * 경로는 풀을 쓰면 안 되고 `RAPIDAPI_KEY` 단일 키를 그대로 쓴다.
 */

/** 이 상태코드는 "이 키로는 못 쓴다"는 뜻이므로 다음 키로 넘어간다. */
export function shouldRotateOnStatus(status: number): boolean {
  return status === 429 || status === 403;
}

/**
 * `RAPIDAPI_KEYS`(콤마 구분) + `RAPIDAPI_KEY` 를 합쳐 중복 없는 키 목록을 만든다.
 * 순서가 곧 소진 순서다 — `RAPIDAPI_KEYS` 에 적은 순서대로 태운다.
 */
export function getRapidApiKeyPool(): string[] {
  const pool: string[] = [];
  const push = (raw: string | undefined) => {
    for (const k of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!pool.includes(k)) pool.push(k);
    }
  };
  push(process.env.RAPIDAPI_KEYS);
  push(process.env.RAPIDAPI_KEY);
  return pool;
}

/**
 * 풀의 키를 순서대로 시도하며 RapidAPI 를 호출한다.
 * 쿼터 소진(429)·미구독(403)이면 다음 키로 넘어가고, 그 외 응답은 즉시 반환한다.
 * 전부 소진되면 **마지막 응답을 그대로 반환**한다 — 호출부가 429 를 보고 판단하도록.
 */
export async function rapidApiFetch(
  url: string,
  init: { method?: string; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Response> {
  const keys = getRapidApiKeyPool();
  if (keys.length === 0) {
    throw new Error("RAPIDAPI_KEYS or RAPIDAPI_KEY not configured");
  }

  const host = new URL(url).hostname;
  let last: Response | null = null;

  for (const key of keys) {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      signal: init.signal,
      headers: { ...init.headers, "x-rapidapi-host": host, "x-rapidapi-key": key },
    });
    if (!shouldRotateOnStatus(res.status)) return res;
    // 다음 키로 넘어가기 전에 본문을 비워 소켓을 놓아준다.
    await res.arrayBuffer().catch(() => undefined);
    last = res;
  }

  return last as Response;
}
