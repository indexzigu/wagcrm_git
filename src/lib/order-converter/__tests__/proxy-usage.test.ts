import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertMock, updateMock } = vi.hoisted(() => ({ upsertMock: vi.fn(), updateMock: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  getPrisma: () => ({ proxyRequestDaily: { upsert: upsertMock, update: updateMock } }),
}));
// 크론 기록 게이트(시크릿 일치)를 통과시켜 인증된 크론 경로도 태운다 — 인증되지 않은 호출은 헤더가 없어 따로 갈린다.
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => true }));

import {
  flushProxyRequestCounts,
  getProxySource,
  incrementProxyRequestDaily,
  proxyTargetLabel,
  recordProxyRequest,
  runWithProxySource,
  UNLABELED_PROXY_SOURCE,
  withProxySource,
} from '../proxy-usage';

const KST_0911_0630 = Date.UTC(2026, 8, 10, 21, 30); // KST 09.11 06:30
const NAVER_ORDER_URL = 'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query';

beforeEach(async () => {
  await flushProxyRequestCounts(); // 앞 테스트의 적재분을 비운다
  upsertMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyTargetLabel', () => {
  it.each([
    ['https://api.commerce.naver.com/external/v1/oauth2/token', 'naver:token'],
    [NAVER_ORDER_URL, 'naver:order'],
    ['https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?lastChangedFrom=x', 'naver:order'],
    ['https://api.commerce.naver.com/external/v1/pay-settle/settle/case?startDate=2026-09-01', 'naver:settlement'],
    ['https://api.commerce.naver.com/external/v1/products/search', 'naver:product'],
    ['https://api.commerce.naver.com/external/v2/products/channel-products/123456', 'naver:product'],
    ['https://api.commerce.naver.com/external/v1/contents/qnas?page=1', 'naver:qna'],
    ['https://api.commerce.naver.com/external/v1/pay-user/inquiries', 'naver:qna'],
    ['https://api.commerce.naver.com/external/v2/product-delivery-info/return-delivery-companies', 'naver:other'],
  ])('%s → %s', (url, label) => {
    expect(proxyTargetLabel(url)).toBe(label);
  });

  it('네이버가 아니면 호스트만 남긴다 — 경로·쿼리의 식별자·토큰은 버린다(P0)', () => {
    expect(proxyTargetLabel('https://graph.instagram.com/v21.0/12345/media?access_token=SECRET')).toBe('graph.instagram.com');
  });

  it('해석할 수 없는 URL 은 invalid-url', () => {
    expect(proxyTargetLabel('not a url')).toBe('invalid-url');
  });
});

describe('runWithProxySource / withProxySource / getProxySource', () => {
  it('라벨 밖은 unlabeled, 안은 그 라벨, 안쪽 라벨이 이긴다', async () => {
    expect(getProxySource()).toBe(UNLABELED_PROXY_SOURCE);
    await runWithProxySource('cron:naver-settlement-sync', async () => {
      await Promise.resolve();
      expect(getProxySource()).toBe('cron:naver-settlement-sync');
      await runWithProxySource('product-search', async () => {
        expect(getProxySource()).toBe('product-search');
      });
      expect(getProxySource()).toBe('cron:naver-settlement-sync');
    });
  });

  it('withProxySource 는 핸들러를 인자 그대로 그 라벨 안에서 돌린다', async () => {
    const handler = withProxySource('dispatch', async (a: number, b: string) => `${getProxySource()}:${a}:${b}`);
    await expect(handler(1, 'x')).resolves.toBe('dispatch:1:x');
  });
});

describe('recordProxyRequest → flushProxyRequestCounts', () => {
  it('같은 (KST 날짜 · 라벨 · target) 시도는 메모리에 모았다가 한 번에 올린다', async () => {
    runWithProxySource('entry-sync', () => {
      recordProxyRequest({ url: NAVER_ORDER_URL, failed: false, nowMs: KST_0911_0630 });
      recordProxyRequest({ url: NAVER_ORDER_URL, failed: false, nowMs: KST_0911_0630 });
    });
    expect(upsertMock).not.toHaveBeenCalled(); // 요청 경로는 DB 를 기다리지 않는다

    await flushProxyRequestCounts();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toEqual({
      where: { day_source_target: { day: '2026-09-11', source: 'entry-sync', target: 'naver:order' } },
      create: { day: '2026-09-11', source: 'entry-sync', target: 'naver:order', requests: 2, failures: 0 },
      update: { requests: { increment: 2 } },
    });
  });

  it('실패한 시도는 failures 도 올린다', async () => {
    recordProxyRequest({ url: 'https://graph.instagram.com/x', failed: true, nowMs: KST_0911_0630 });
    await flushProxyRequestCounts();
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      create: { source: UNLABELED_PROXY_SOURCE, target: 'graph.instagram.com', requests: 1, failures: 1 },
      update: { requests: { increment: 1 }, failures: { increment: 1 } },
    });
  });

  it('따로 부르지 않아도 짧은 간격 뒤 스스로 쓴다', async () => {
    recordProxyRequest({ url: NAVER_ORDER_URL, failed: false, nowMs: KST_0911_0630 });
    await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('쓰기가 실패해도 throw 하지 않고 console.error 로 남긴다', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    upsertMock.mockRejectedValueOnce(new Error('db down'));
    expect(() => recordProxyRequest({ url: 'https://graph.instagram.com/x', failed: false })).not.toThrow();
    await expect(flushProxyRequestCounts()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[proxy-usage]'), expect.any(Error));
  });
});

describe('withSystemTaskStatus — 크론 라벨', () => {
  it.each([
    ['시크릿 없는 수동 호출', new Request('http://localhost/api/cron/naver-settlement-sync')],
    [
      '인증된 크론 호출',
      new Request('http://localhost/api/cron/naver-settlement-sync', { headers: { authorization: 'Bearer test' } }),
    ],
  ])('%s 안의 프록시 요청은 cron:<작업> 으로 센다', async (_name, request) => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // 상태 기록은 대역이 없어 실패 로그만 남긴다
    const { withSystemTaskStatus } = await import('@/lib/system-task-status');
    let seen = '';
    const route = withSystemTaskStatus('naver-settlement-sync', async () => {
      seen = getProxySource();
      return new Response('ok');
    });

    await route(request);

    expect(seen).toBe('cron:naver-settlement-sync');
  });
});

describe('incrementProxyRequestDaily', () => {
  it('첫 삽입이 동시에 겹쳐 유니크 충돌(P2002)이 나면 update 로 한 번 재시도한다', async () => {
    upsertMock.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await incrementProxyRequestDaily({ day: '2026-09-11', source: 'manual-sync', target: 't', requests: 3, failures: 0 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { day_source_target: { day: '2026-09-11', source: 'manual-sync', target: 't' } },
      data: { requests: { increment: 3 } },
    });
  });

  it('그 밖의 오류는 호출부(flush)가 잡도록 던진다', async () => {
    upsertMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      incrementProxyRequestDaily({ day: 'd', source: 'manual-sync', target: 't', requests: 1, failures: 0 }),
    ).rejects.toThrow('db down');
  });
});
