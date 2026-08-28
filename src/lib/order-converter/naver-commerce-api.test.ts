import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `searchNaverProducts` 의 60초 TTL 쿨다운 계약.
 *
 * 배경(실측 2026-07-30): 이 조회는 `campaigns-handler` 의 `needsNaver` 가 참인 동안
 * **대시보드 GET 1회당 1회** 나갔고(30일 776회), 핸들러 안에서 동기 await 돼
 * 대시보드 응답의 약 43%(avg 751ms)를 차지했다. 아래 4건이 그 쿨다운의 계약이다 —
 * 특히 ②는 "쿨다운이 판매기간 연장 반영을 영구히 막지 않는다"를 고정한다.
 */

const proxyFetchMock = vi.fn();
vi.mock('./fetch-client', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}));

// bcrypt.hashSync 는 salt 로 실제 bcrypt 문자열을 요구한다 — 토큰 서명은 이 테스트의 관심사가 아니다.
vi.mock('bcrypt', () => ({ default: { hashSync: () => 'signed' } }));

const recordNaverCallFailureMock = vi.fn();
// naver-api-usage 는 모듈 로드 시 prisma 를 끌고 온다 — 전량 대체한다.
vi.mock('./naver-api-usage', () => ({
  getNaverCallTally: () => undefined,
  noteNaverHttpAttempt: vi.fn(),
  toNaverEndpointLabel: (p: string) => p,
  recordNaverCallFailure: (...args: unknown[]) => recordNaverCallFailureMock(...args),
}));

const TOKEN_URL = 'https://api.commerce.naver.com/external/v1/oauth2/token';
const SEARCH_URL = 'https://api.commerce.naver.com/external/v1/products/search';

/** 상품 검색 응답 큐. 각 원소는 성공 페이로드이거나 `{ fail: status }`. */
let searchResponses: Array<{ contents: unknown[] } | { fail: number }>;

function searchCallCount() {
  return proxyFetchMock.mock.calls.filter(([url]) => url === SEARCH_URL).length;
}

async function importModule() {
  return await import('./naver-commerce-api');
}

beforeEach(async () => {
  vi.resetModules();
  proxyFetchMock.mockReset();
  recordNaverCallFailureMock.mockReset();
  searchResponses = [];

  // 라우트 번들 간 캐시 공유용 전역 상태 — 테스트 간 누수 방지.
  delete (global as Record<string, unknown>).__naverProductsSearchCache;
  delete (global as Record<string, unknown>).__naverProductsSearchInFlight;

  // 값은 "비어 있지 않음"만 만족하면 된다(서명은 bcrypt 모킹으로 우회). 커밋 가드가
  // 시크릿 env 이름에 16자+ 리터럴 대입을 차단하므로 플레이스홀더도 짧게 둔다(P6).
  process.env.NAVER_CLIENT_ID = 'id';
  process.env.NAVER_CLIENT_SECRET = 'secret';
  delete process.env.NAVER_CLIENT_SECRET_BASE64;

  proxyFetchMock.mockImplementation(async (url: string) => {
    if (url === TOKEN_URL) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: '7200' }) };
    }
    const next = searchResponses.shift();
    if (next && 'fail' in next) {
      return { ok: false, status: next.fail, text: async () => 'boom' };
    }
    return { ok: true, json: async () => next ?? { contents: [] } };
  });

  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchNaverProducts 쿨다운', () => {
  it('① TTL(60초) 안의 재호출은 네이버를 때리지 않고 같은 결과를 돌려준다', async () => {
    const { searchNaverProducts } = await importModule();
    searchResponses = [{ contents: [{ originProductNo: 1 }] }];

    const first = await searchNaverProducts();
    vi.setSystemTime(new Date('2026-07-30T00:00:59.000Z'));
    const second = await searchNaverProducts();

    expect(searchCallCount()).toBe(1);
    expect(second).toBe(first);
    expect(second.contents).toHaveLength(1);
  });

  it('② TTL 이 지나면 다시 조회한다 — 쿨다운이 판매기간 연장 반영을 영구히 막지 않는다', async () => {
    const { searchNaverProducts } = await importModule();
    searchResponses = [{ contents: [{ saleEndDate: 'before' }] }, { contents: [{ saleEndDate: 'extended' }] }];

    const first = await searchNaverProducts();
    vi.setSystemTime(new Date('2026-07-30T00:01:01.000Z'));
    const second = await searchNaverProducts();

    expect(searchCallCount()).toBe(2);
    expect((first.contents[0] as { saleEndDate: string }).saleEndDate).toBe('before');
    expect((second.contents[0] as { saleEndDate: string }).saleEndDate).toBe('extended');
  });

  it('③ 동시 진입은 in-flight dedupe 로 1회만 나간다', async () => {
    const { searchNaverProducts } = await importModule();
    searchResponses = [{ contents: [{ originProductNo: 7 }] }];

    const [a, b, c] = await Promise.all([
      searchNaverProducts(),
      searchNaverProducts(),
      searchNaverProducts(),
    ]);

    expect(searchCallCount()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('④ 실패는 캐시하지 않는다 — 다음 호출이 즉시 재시도하고 실패 계측은 그대로 남는다', async () => {
    const { searchNaverProducts } = await importModule();
    searchResponses = [{ fail: 500 }, { contents: [{ originProductNo: 9 }] }];

    await expect(searchNaverProducts()).rejects.toThrow(/Naver Products Error/);
    expect(recordNaverCallFailureMock).toHaveBeenCalledTimes(1);

    // TTL 을 기다리지 않고 같은 순간에 재호출해도 새 조회가 나가야 한다(장애가 TTL 만큼 연장되지 않는다).
    const recovered = await searchNaverProducts();

    expect(searchCallCount()).toBe(2);
    expect(recovered.contents).toHaveLength(1);
  });
});
