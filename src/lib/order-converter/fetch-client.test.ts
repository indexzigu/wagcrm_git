import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `proxyFetch` 의 프록시 에이전트 재사용 계약.
 *
 * 배경: 종전 구현은 호출마다 `new ProxyAgent(...)` 를 만들었다. undici 의
 * ProxyAgent 는 내부 풀에 CONNECT 터널을 유지해 재사용하는데, 인스턴스를 매번
 * 새로 만들면 그 재사용이 구조적으로 0이 되어 **HTTP 요청 1건 = 프록시 터널 1건**
 * 이 된다(로컬 프록시 실측: 요청 5건 → 터널 5개 / 공유 시 1개). 프록시 요금제는
 * 그 터널 수를 사용량으로 세므로 곧바로 한도 소진으로 이어졌고, 실제로 한도가
 * 차서 프록시가 407 을 돌려주는 동안 네이버 크론 3종이 함께 멈췄다.
 *
 * ⛔ 이 계약을 지우고 `new ProxyAgent` 를 호출 경로로 되돌리지 말 것.
 *
 * 🪤 dispatcher 는 **호출 시점에** 기록한다 — `proxyFetch` 는 호출자의 `options`
 * 객체를 그 자리에서 고쳐 쓰므로(`options.dispatcher = ...`), 폴백이 일어나면
 * 나중 시도가 앞 시도의 기록까지 덮어 `mock.calls` 를 나중에 읽는 방식은
 * 프라이머리 시도를 영영 못 본다.
 */

/** 다음 몇 번의 터널 시도를 실패시킬지(폴백 경로 유도용). */
let failTunnelCount = 0;
/** undiciFetch 가 실제로 받은 dispatcher — 호출 시점에 남긴다. */
let dispatcherLog: unknown[] = [];

const undiciFetchMock = vi.fn(async (_url: unknown, options?: { dispatcher?: unknown }) => {
  dispatcherLog.push(options?.dispatcher);
  if (failTunnelCount > 0) {
    failTunnelCount--;
    throw new Error('tunnel refused');
  }
  return { ok: true, status: 200 };
});

class FakeProxyAgent {
  static instances: FakeProxyAgent[] = [];
  constructor(readonly options: unknown) {
    FakeProxyAgent.instances.push(this);
  }
}

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => (undiciFetchMock as (...a: unknown[]) => unknown)(...args),
  ProxyAgent: FakeProxyAgent,
}));

const PROXY = 'http://proxy-a.example:8080';
const PROXY_FALLBACK = 'http://proxy-b.example:8080';

beforeEach(() => {
  vi.resetModules();
  undiciFetchMock.mockClear();
  FakeProxyAgent.instances = [];
  dispatcherLog = [];
  failTunnelCount = 0;
  // 에이전트 캐시는 라우트 번들 간 공유를 위해 globalThis 에 산다 — 테스트 간 누수 방지.
  delete (globalThis as Record<string, unknown>).__wagProxyAgentCache;
  delete process.env.PROXY_URLS;
  delete process.env.FIXIE_URLS;
  delete process.env.FIXIE_URL;
  // 폴백 경로가 console.warn 을 남긴다 — 테스트 출력만 조용히 한다.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('proxyFetch', () => {
  it('같은 프록시 URL 이면 에이전트를 한 번만 만들고 모든 요청이 그것을 공유한다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    await proxyFetch('https://example.test/a');
    await proxyFetch('https://example.test/b');
    await proxyFetch('https://example.test/c');

    expect(FakeProxyAgent.instances).toHaveLength(1);
    expect(dispatcherLog).toEqual(Array(3).fill(FakeProxyAgent.instances[0]));
  });

  it('프록시 설정이 없으면 dispatcher 없이 직결한다', async () => {
    const { proxyFetch } = await import('./fetch-client');

    await proxyFetch('https://example.test/a');

    expect(FakeProxyAgent.instances).toHaveLength(0);
    expect(dispatcherLog).toEqual([undefined]);
  });

  it('프록시가 여러 개면 URL 별로 에이전트를 나눠 캐시한다', async () => {
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    // 프라이머리 터널이 거절되면 서브로 넘어간다(기존 폴백 경로).
    failTunnelCount = 1;
    await proxyFetch('https://example.test/a');
    failTunnelCount = 1;
    await proxyFetch('https://example.test/b');

    // 프라이머리·서브가 각자 에이전트를 갖고, 2회차에도 새로 만들지 않는다.
    expect(FakeProxyAgent.instances).toHaveLength(2);
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(primary).not.toBe(fallback);
    expect(dispatcherLog).toEqual([primary, fallback, primary, fallback]);
  });
});
