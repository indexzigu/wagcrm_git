// RapidAPI 키 풀·순차 소진 로테이션 테스트 (2026-07-23).
// 오너가 무료 플랜 쿼터 확보를 위해 계정 3개를 돌려 쓴다. 이전 구현은 모듈 전역
// 라운드로빈이라 서버리스에서 인스턴스마다 첫 키만 태웠고 429 대응이 없었다 —
// 그 두 결함이 되살아나지 않도록 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRapidApiKeyPool, rapidApiFetch, shouldRotateOnStatus } from "../rapidapi-keys";

const ORIGINAL_ENV = { ...process.env };
const URL_A = "https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=x";

/** status 순서대로 응답하는 fetch 목. 사용된 키를 순서대로 기록한다. */
function mockFetchSequence(statuses: number[]) {
  const usedKeys: string[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    usedKeys.push(headers["x-rapidapi-key"]);
    const status = statuses[usedKeys.length - 1] ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return { usedKeys, fn };
}

beforeEach(() => {
  delete process.env.RAPIDAPI_KEYS;
  delete process.env.RAPIDAPI_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("getRapidApiKeyPool", () => {
  it("RAPIDAPI_KEYS 를 적은 순서대로 푼다(순서 = 소진 순서)", () => {
    process.env.RAPIDAPI_KEYS = "k1, k2 ,k3";
    expect(getRapidApiKeyPool()).toEqual(["k1", "k2", "k3"]);
  });

  it("RAPIDAPI_KEY 를 뒤에 붙이되 중복은 넣지 않는다", () => {
    process.env.RAPIDAPI_KEYS = "k1,k2";
    process.env.RAPIDAPI_KEY = "k2";
    expect(getRapidApiKeyPool()).toEqual(["k1", "k2"]);

    process.env.RAPIDAPI_KEY = "k9";
    expect(getRapidApiKeyPool()).toEqual(["k1", "k2", "k9"]);
  });

  it("RAPIDAPI_KEY 만 있어도 1개짜리 풀이 된다(기존 단일 키 구성 호환)", () => {
    process.env.RAPIDAPI_KEY = "solo";
    expect(getRapidApiKeyPool()).toEqual(["solo"]);
  });

  it("빈 문자열·공백은 걸러낸다", () => {
    process.env.RAPIDAPI_KEYS = "k1,, ,k2,";
    expect(getRapidApiKeyPool()).toEqual(["k1", "k2"]);
  });
});

describe("shouldRotateOnStatus", () => {
  it("429(쿼터 소진)·403(미구독)에서만 다음 키로 넘어간다", () => {
    expect(shouldRotateOnStatus(429)).toBe(true);
    expect(shouldRotateOnStatus(403)).toBe(true);
    // 아래는 키를 바꿔도 결과가 같다 — 낭비 호출을 만들지 않는다.
    for (const s of [200, 400, 401, 404, 500, 503]) {
      expect(shouldRotateOnStatus(s), `status ${s}`).toBe(false);
    }
  });
});

describe("rapidApiFetch", () => {
  it("키가 하나도 없으면 던진다", async () => {
    await expect(rapidApiFetch(URL_A)).rejects.toThrow(/RAPIDAPI_KEYS or RAPIDAPI_KEY/);
  });

  it("첫 키가 살아있으면 그 키만 쓰고 끝낸다(불필요한 로테이션 없음)", async () => {
    process.env.RAPIDAPI_KEYS = "k1,k2,k3";
    const { usedKeys } = mockFetchSequence([200]);

    const res = await rapidApiFetch(URL_A);
    expect(res.status).toBe(200);
    expect(usedKeys).toEqual(["k1"]);
  });

  it("429 면 다음 키로 넘어간다(쿼터 소진 → 다음 계정)", async () => {
    process.env.RAPIDAPI_KEYS = "k1,k2,k3";
    const { usedKeys } = mockFetchSequence([429, 200]);

    const res = await rapidApiFetch(URL_A);
    expect(res.status).toBe(200);
    expect(usedKeys).toEqual(["k1", "k2"]);
  });

  it("403(미구독) 도 건너뛴다 — 키마다 구독 API 가 다르다", async () => {
    process.env.RAPIDAPI_KEYS = "k1,k2,k3";
    const { usedKeys } = mockFetchSequence([403, 429, 200]);

    expect((await rapidApiFetch(URL_A)).status).toBe(200);
    expect(usedKeys).toEqual(["k1", "k2", "k3"]);
  });

  it("전부 소진되면 마지막 응답을 그대로 돌려준다(호출부가 429 를 본다)", async () => {
    process.env.RAPIDAPI_KEYS = "k1,k2";
    const { usedKeys } = mockFetchSequence([429, 429]);

    const res = await rapidApiFetch(URL_A);
    expect(res.status).toBe(429);
    expect(usedKeys).toEqual(["k1", "k2"]);
  });

  it("429·403 이 아닌 실패는 로테이션하지 않는다(핸들 오류로 풀을 태우지 않도록)", async () => {
    process.env.RAPIDAPI_KEYS = "k1,k2,k3";
    const { usedKeys } = mockFetchSequence([404]);

    expect((await rapidApiFetch(URL_A)).status).toBe(404);
    expect(usedKeys).toEqual(["k1"]);
  });

  it("호출 간 상태를 들고 있지 않는다 — 매 호출이 k1 부터 시작한다(서버리스 안전)", async () => {
    // 구 구현은 모듈 전역 keyIndex 라운드로빈이라 호출마다 키가 밀렸고,
    // 서버리스에서는 인스턴스마다 0으로 리셋돼 사실상 첫 키만 태웠다.
    process.env.RAPIDAPI_KEYS = "k1,k2,k3";
    const { usedKeys } = mockFetchSequence([200, 200, 200]);

    await rapidApiFetch(URL_A);
    await rapidApiFetch(URL_A);
    await rapidApiFetch(URL_A);
    expect(usedKeys).toEqual(["k1", "k1", "k1"]);
  });

  it("호스트 헤더를 URL 에서 파생한다(호출부가 호스트를 중복해 적지 않도록)", async () => {
    process.env.RAPIDAPI_KEY = "solo";
    const { fn } = mockFetchSequence([200]);

    await rapidApiFetch(URL_A);
    const headers = fn.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-rapidapi-host"]).toBe("instagram-scraper-20251.p.rapidapi.com");
  });
});
