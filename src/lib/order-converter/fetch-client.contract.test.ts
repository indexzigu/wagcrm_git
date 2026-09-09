import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `proxyFetch` 의 프록시 에이전트 재사용 계약.
 *
 * 배경: 종전 구현은 호출마다 `new ProxyAgent(...)` 를 만들었다. undici 의
 * ProxyAgent 는 내부 풀에 CONNECT 터널을 유지해 재사용하는데, 인스턴스를 매번
 * 새로 만들면 그 재사용이 구조적으로 0이 되어 **HTTP 요청 1건 = 프록시 터널 1건**
 * 이 된다(로컬 프록시 실측: 순차 요청 5건 → 터널 5개 / 공유 시 1개). 프록시 요금제는
 * 그 터널 수를 사용량으로 세므로 곧바로 한도 소진으로 이어졌고, 실제로 한도가
 * 차서 프록시가 407 을 돌려주는 동안 네이버 크론 3종이 함께 멈췄다.
 *
 * ⛔ 이 계약을 지우고 `new ProxyAgent` 를 호출 경로로 되돌리지 말 것.
 *
 * 🪤 dispatcher 는 **호출 시점에** 기록한다 — `proxyFetch` 는 호출자의 `options`
 * 객체를 그 자리에서 고쳐 쓰므로(`options.dispatcher = ...`), 재시도·폴백이 일어나면
 * 나중 시도가 앞 시도의 기록까지 덮어 `mock.calls` 를 나중에 읽는 방식은
 * 앞선 시도를 영영 못 본다.
 *
 * 🪤 **프록시의 407 은 `res.status` 로 오지 않는다 — 예외로 온다.** 근거와 실측은
 * 아래 `proxyRejected()` 주석에 있다.
 */

/**
 * 다음 요청들을 어떻게 실패시킬지(앞에서부터 소비). 두 실패를 **구분해서** 넣는다 —
 * 재시도해야 하는 것(죽은 소켓)과 재시도하면 안 되는 것(프록시의 확정 거절)이
 * 테스트상 같은 얼굴이면 계약이 아무것도 고정하지 못한다.
 */
type FailureKind = 'deadSocket' | 'proxyRejected' | 'proxyRejectedInAggregate';
let failureQueue: FailureKind[] = [];
/** 실패가 아닐 때 돌려줄 상태코드(앞에서부터 소비, 비면 200). */
let statusQueue: number[] = [];
/** undiciFetch 가 실제로 받은 dispatcher — 호출 시점에 남긴다. */
let dispatcherLog: unknown[] = [];

/**
 * 재사용하려던 터널이 이미 죽어 있던 경우. undici 의 소켓 오류 모양.
 */
function deadSocket(): Error {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = new Error('other side closed');
  return err;
}

/**
 * 프록시가 CONNECT 를 거절한 경우 — **한도 소진의 407 이 이 모양이다.**
 * 🪤 407 은 `res.status` 로 오지 않는다: 로컬 프록시가 CONNECT 에 407 을 답하면
 * undici 가 이 형태로 던지고 `catch` 경로를 탄다(프록시 A=407 · B=정상 프로브에서
 * B 로 넘어가 200 을 받는 것을 확인했다). 리뷰에서 두 번 "폴백이 안 된다"고
 * 지적됐으나 실측으로 반증됐다.
 * ⚠️ 이 문장은 **undici 의 동작에 대한 가정**이고, 여기서 목을 쓰는 한 이 파일이
 * 그것을 증명하지는 못한다 — 근거는 위 프로브와 프로덕션 로그다.
 */
function proxyRejected(): Error {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = new Error(
    'Proxy response (407) !== 200 when HTTP Tunneling',
  );
  return err;
}

/**
 * 같은 407 이 `AggregateError` 안에 실려 오는 경우. `AggregateError` 는 원인을 `cause` 가
 * 아니라 `errors` 배열에 담으므로, 사슬만 훑는 판별은 이것을 **놓치고 재시도를 허용하는
 * 쪽으로** 틀린다(happy-eyeballs 처럼 여러 주소를 시도하면 이 모양이 나온다).
 */
function proxyRejectedInAggregate(): Error {
  const aggregate = new AggregateError(
    [new Error('ECONNREFUSED'), new Error('Proxy response (407) !== 200 when HTTP Tunneling')],
    'all attempts failed',
  );
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = aggregate;
  return err;
}

const undiciFetchMock = vi.fn(async (_url: unknown, options?: { dispatcher?: unknown }) => {
  dispatcherLog.push(options?.dispatcher);
  const failure = failureQueue.shift();
  if (failure === 'deadSocket') throw deadSocket();
  if (failure === 'proxyRejected') throw proxyRejected();
  if (failure === 'proxyRejectedInAggregate') throw proxyRejectedInAggregate();
  const status = statusQueue.shift() ?? 200;
  return { ok: status >= 200 && status < 300, status };
});

class FakeProxyAgent {
  static instances: FakeProxyAgent[] = [];
  constructor(readonly options: Record<string, unknown>) {
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
  failureQueue = [];
  statusQueue = [];
  // 에이전트 캐시는 라우트 번들 간 공유를 위해 globalThis 에 산다 — 테스트 간 누수 방지.
  delete (globalThis as Record<string, unknown>).__wagProxyAgentCache;
  delete process.env.PROXY_URLS;
  delete process.env.FIXIE_URLS;
  delete process.env.FIXIE_URL;
  // 재시도·폴백 경로가 console.warn 을 남긴다 — 테스트 출력만 조용히 한다.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('proxyFetch — 에이전트 재사용', () => {
  it('같은 프록시 URL 이면 에이전트를 한 번만 만들고 모든 요청이 그것을 공유한다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    await proxyFetch('https://example.test/a');
    await proxyFetch('https://example.test/b');
    await proxyFetch('https://example.test/c');

    expect(FakeProxyAgent.instances).toHaveLength(1);
    expect(dispatcherLog).toEqual(Array(3).fill(FakeProxyAgent.instances[0]));
  });

  it('관측된 호출 간격을 덮는 유휴 타임아웃으로 에이전트를 만든다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');
    await proxyFetch('https://example.test/a');

    // 크론 1회 실행 안 호출 간격이 3~4초라 undici 기본값 4초로는 재사용이 깨진다.
    // ⛔ 키우려면 프록시의 실제 유휴 타임아웃을 먼저 실측할 것(소스 주석 참조).
    expect(FakeProxyAgent.instances[0].options).toMatchObject({
      uri: PROXY,
      keepAliveTimeout: 15_000,
    });
  });

  it('모듈이 다시 로드돼도 에이전트를 새로 만들지 않는다', async () => {
    process.env.PROXY_URLS = PROXY;
    const first = await import('./fetch-client');
    await first.proxyFetch('https://example.test/a');

    // 이 모듈은 서로 다른 라우트 번들에서 import 돼 인스턴스가 갈릴 수 있다 —
    // 캐시를 모듈 지역 변수에 두면 번들마다 에이전트가 새로 생긴다. 그 상황을 재현한다.
    vi.resetModules();
    const second = await import('./fetch-client');
    await second.proxyFetch('https://example.test/b');

    expect(second).not.toBe(first);
    expect(FakeProxyAgent.instances).toHaveLength(1);
    expect(dispatcherLog).toEqual(Array(2).fill(FakeProxyAgent.instances[0]));
  });

  it('프록시가 여러 개면 URL 별로 에이전트를 나눠 캐시한다', async () => {
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    // 프라이머리가 재시도까지 실패해야 서브로 넘어간다(죽은 소켓은 프록시당 2회).
    failureQueue = ['deadSocket', 'deadSocket'];
    await proxyFetch('https://example.test/a');
    failureQueue = ['deadSocket', 'deadSocket'];
    await proxyFetch('https://example.test/b');

    // 프라이머리·서브가 각자 에이전트를 갖고, 2회차에도 새로 만들지 않는다.
    expect(FakeProxyAgent.instances).toHaveLength(2);
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(primary).not.toBe(fallback);
    expect(dispatcherLog).toEqual([primary, primary, fallback, primary, primary, fallback]);
  });

  it('프록시 설정이 없으면 dispatcher 없이 직결한다', async () => {
    const { proxyFetch } = await import('./fetch-client');

    await proxyFetch('https://example.test/a');

    expect(FakeProxyAgent.instances).toHaveLength(0);
    expect(dispatcherLog).toEqual([undefined]);
  });
});

/**
 * 터널을 재사용하면 **프록시가 먼저 끊은 죽은 소켓**을 집는 실패 모드가 생긴다
 * (호출마다 새 소켓을 열던 종전에는 없던 경로). 같은 프록시로 1회만 다시 시도해 흡수하되,
 * **다시 보내도 소용없거나 해로운 실패는 가려낸다.**
 */
describe('proxyFetch — 실패 처리', () => {
  it('GET 은 죽은 터널을 같은 프록시로 1회 재시도한다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['deadSocket'];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 200 });
    // 같은 에이전트로 두 번 나갔다 — 프록시를 갈아타지 않았다.
    expect(FakeProxyAgent.instances).toHaveLength(1);
    expect(dispatcherLog).toEqual(Array(2).fill(FakeProxyAgent.instances[0]));
  });

  it('POST 는 재시도하지 않고 그대로 던진다', async () => {
    // ⛔ 이 계약을 완화하지 말 것 — 이 경로에는 네이버 주문확인·발주요청처럼
    //    되돌릴 수 없는 부수효과 호출이 흐른다. 응답을 못 받은 POST 를 다시 보내면
    //    같은 주문이 두 번 나갈 수 있다.
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['deadSocket'];
    await expect(proxyFetch('https://example.test/a', { method: 'POST' })).rejects.toThrow(
      'fetch failed',
    );

    expect(dispatcherLog).toHaveLength(1);
  });

  it('프록시가 CONNECT 를 거절하면(한도 소진 407) 재시도 없이 다음 프록시로 넘어간다', async () => {
    // ⛔ 이것을 재시도로 되돌리지 말 것 — 확정 거절이라 다시 보내도 결과가 같고,
    //    **사용량을 줄이려는 이 변경이 정확히 실패 구간에서 사용량을 두 배로 태운다.**
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['proxyRejected'];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 200 });
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(dispatcherLog).toEqual([primary, fallback]); // 프라이머리는 1회뿐
  });

  it('프록시가 하나뿐이면 CONNECT 거절은 1회 시도로 끝난다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['proxyRejected'];
    await expect(proxyFetch('https://example.test/a')).rejects.toThrow('fetch failed');

    expect(dispatcherLog).toHaveLength(1);
  });

  it('호출자가 이미 포기한 요청은 재시도하지 않는다', async () => {
    // `reference-enrich-proxy.ts` 는 `AbortSignal.timeout` 을 넘긴다 — 예산을 다 쓴 뒤
    // 같은 signal 로 다시 보내면 즉시 같은 자리에서 죽으므로 재시도가 아니라 낭비다.
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['deadSocket'];
    await expect(
      proxyFetch('https://example.test/a', { signal: { aborted: true } }),
    ).rejects.toThrow('fetch failed');

    expect(dispatcherLog).toHaveLength(1);
  });

  it('403 응답은 재시도 없이 다음 프록시로 넘어간다', async () => {
    // 상태 기반 폴백은 예외 경로가 아니라 `res.status` 분기다 — **이 PR 에서** 재시도를
    // 넣으며 `continue` 를 `break` 로 바꾼 자리라(`fa59934f` → `d0ef22e7`), 이 계약이
    // 그 치환을 고정한다.
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    statusQueue = [403];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 200 });
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(dispatcherLog).toEqual([primary, fallback]);
  });

  it('429 응답도 다음 프록시로 넘어간다', async () => {
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    statusQueue = [429];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 200 });
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(dispatcherLog).toEqual([primary, fallback]);
  });

  it('50x 응답도 다음 프록시로 넘어간다', async () => {
    // 폴백 조건은 세 갈래(403 · 429 · >=500)다 — 셋 다 계약으로 고정한다.
    process.env.PROXY_URLS = `${PROXY},${PROXY_FALLBACK}`;
    const { proxyFetch } = await import('./fetch-client');

    statusQueue = [503];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 200 });
    const [primary, fallback] = FakeProxyAgent.instances;
    expect(dispatcherLog).toEqual([primary, fallback]);
  });

  it('AggregateError 안의 CONNECT 거절도 재시도하지 않는다', async () => {
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    failureQueue = ['proxyRejectedInAggregate'];
    await expect(proxyFetch('https://example.test/a')).rejects.toThrow('fetch failed');

    expect(dispatcherLog).toHaveLength(1);
  });

  it('마지막 프록시의 403 은 폴백 없이 그대로 반환된다', async () => {
    // 폴백은 "다음 프록시가 있을 때"만이다 — 없으면 응답을 삼키지 않고 그대로 돌려준다.
    process.env.PROXY_URLS = PROXY;
    const { proxyFetch } = await import('./fetch-client');

    statusQueue = [403];
    const res = await proxyFetch('https://example.test/a');

    expect(res).toMatchObject({ status: 403 });
    expect(dispatcherLog).toHaveLength(1);
  });

  it('CONNECT 거절 판별이 undici 의 실제 메시지와 묶여 있다', () => {
    // 🪤 이 판별은 undici 가 던지는 **문자열**에 의존한다. 픽스처(`proxyRejected`)는 그
    //    문자열을 손으로 옮겨 적은 것이라, 라이브러리가 문구를 바꾸면 판별만 조용히 죽고
    //    위 계약들은 초록으로 남는다(= 이 PR 이 고친 결함으로 복귀). 게다가 undici 는
    //    `package.json` 에 선언조차 없는 전이 의존성이라 버전이 임의로 뜬다.
    //    그래서 실물과 대조한다.
    const require_ = createRequire(import.meta.url);
    const undiciDir = dirname(require_.resolve('undici/package.json'));
    // 🪤 이 경로는 **메인 레포의 공유 `node_modules`** 를 가리킨다(워크트리는 그것을
    //    공유한다). prune·재설치 중이면 파일이 없을 수 있는데, 그때 생 ENOENT 만 뜨면
    //    "판별이 깨졌다"로 오독된다 — 무엇을 못 찾았는지 말하고 죽는다.
    const proxyAgentSrc = join(undiciDir, 'lib', 'dispatcher', 'proxy-agent.js');
    expect(
      existsSync(proxyAgentSrc),
      `undici 설치본을 찾지 못했다: ${proxyAgentSrc} (판별 문구를 대조할 수 없다)`,
    ).toBe(true);
    // 🪤 경로를 **세그먼트로 나눠** 넘긴다 — 한 문자열로 적으면 `dead-alert-dispatcher`
    //    계약이 앱 소스의 죽은 알림 발송기 참조로 오인해 실패한다(실측). 여기서 가리키는
    //    것은 undici 의 디렉터리이지 그 모듈이 아니다. ⛔ 한 문자열로 "정리"하지 말 것.
    const src = readFileSync(proxyAgentSrc, 'utf8');

    expect(src).toContain('Proxy response (${statusCode}) !== 200 when HTTP Tunneling');
    // 픽스처가 그 템플릿을 실제로 렌더링한 모양인지도 함께 본다.
    const cause = (proxyRejected() as Error & { cause?: Error }).cause;
    expect(cause?.message).toBe('Proxy response (407) !== 200 when HTTP Tunneling');
  });
});
