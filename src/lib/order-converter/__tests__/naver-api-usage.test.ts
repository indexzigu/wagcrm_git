import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  getPrisma: () => ({ apiCallLog: { create: createMock } }),
}));

import {
  NAVER_API_PROVIDER,
  NAVER_CALL_FAILURE_SCOPE,
  createNaverCallTally,
  getNaverCallTally,
  naverOpScope,
  noteNaverHttpAttempt,
  noteNaverLogicalCall,
  noteNaverRateLimitRetry,
  noteNaverSkippedCall,
  noteNaverTokenRefresh,
  recordNaverCallFailure,
  recordNaverOperationUsage,
  runWithNaverCallTally,
  toNaverEndpointLabel,
} from '../naver-api-usage';

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ id: 'log_1' });
});

describe('toNaverEndpointLabel — P0: 호스트·쿼리를 남기지 않는다', () => {
  it('경로만 있으면 그대로', () => {
    expect(toNaverEndpointLabel('/v1/pay-order/seller/product-orders')).toBe('/v1/pay-order/seller/product-orders');
  });

  it('쿼리스트링을 잘라낸다 — 조회 파라미터·토큰이 endpoint 에 새지 않게', () => {
    expect(toNaverEndpointLabel('/v1/pay-order/seller/product-orders?from=2026-07-30&token=SECRET'))
      .toBe('/v1/pay-order/seller/product-orders');
  });

  it('절대 URL 이 와도 호스트를 버린다', () => {
    expect(toNaverEndpointLabel('https://api.commerce.naver.com/external/v1/products/search'))
      .toBe('/external/v1/products/search');
  });

  it('해시·선행 슬래시 없음·빈 값 방어', () => {
    expect(toNaverEndpointLabel('/v1/a#frag')).toBe('/v1/a');
    expect(toNaverEndpointLabel('v1/a')).toBe('/v1/a');
    expect(toNaverEndpointLabel('')).toBe('/unknown');
    expect(toNaverEndpointLabel(null)).toBe('/unknown');
    expect(toNaverEndpointLabel(undefined)).toBe('/unknown');
  });
});

describe('tally — 논리 호출과 HTTP 시도를 구분한다', () => {
  it('논리 호출·생략·시도·429 재시도가 각각 누적된다', () => {
    const t = createNaverCallTally();
    noteNaverLogicalCall(t);
    noteNaverLogicalCall(t);
    noteNaverSkippedCall(t, 3);
    noteNaverHttpAttempt(t, '/v1/x');
    noteNaverRateLimitRetry(t);
    noteNaverHttpAttempt(t, '/v1/x'); // 429 재시도분
    noteNaverTokenRefresh(t);
    noteNaverHttpAttempt(t, '/v1/y');

    expect(t.logicalCalls).toBe(2);
    expect(t.skipped).toBe(3);
    // 재시도가 있으면 HTTP 시도 > 논리 호출 — 이 구분이 없으면 "19회"의 의미가 흐려진다.
    expect(t.httpAttempts).toBe(3);
    expect(t.rateLimitRetries).toBe(1);
    // 401 재발급은 자기치유 정상 이벤트 — 실패 행이 아니라 이 카운터로만 센다.
    expect(t.tokenRefreshes).toBe(1);
    expect(t.httpAttemptsByEndpoint).toEqual({ '/v1/x': 2, '/v1/y': 1 });
  });

  it('tally 가 없으면(계측 컨텍스트 밖) 조용히 no-op — 계측이 기능을 깨지 않는다', () => {
    expect(() => {
      noteNaverLogicalCall(undefined);
      noteNaverSkippedCall(undefined);
      noteNaverHttpAttempt(undefined, '/v1/x');
      noteNaverRateLimitRetry(undefined);
      noteNaverTokenRefresh(undefined);
    }).not.toThrow();
  });
});

describe('runWithNaverCallTally — 시그니처 변경 없이 컨텍스트를 전달한다', () => {
  it('컨텍스트 안에서는 같은 tally 를 찾고, 밖에서는 undefined', async () => {
    const t = createNaverCallTally();
    expect(getNaverCallTally()).toBeUndefined();

    await runWithNaverCallTally(t, async () => {
      expect(getNaverCallTally()).toBe(t);
      // await 경계를 넘어도 유지돼야 한다(중첩 헬퍼가 apiRequest 를 부르는 실제 구조).
      await Promise.resolve();
      expect(getNaverCallTally()).toBe(t);
    });

    expect(getNaverCallTally()).toBeUndefined();
  });
});

describe('recordNaverCallFailure', () => {
  it('실패 1건 = ApiCallLog 1행(provider=NAVER, success=false)', async () => {
    await recordNaverCallFailure({
      endpointLabel: '/v1/pay-order/seller/product-orders',
      method: 'GET',
      statusCode: 429,
      message: 'GW.RATE_LIMIT',
      retrying: true,
      attempt: 2,
      maxAttempts: 5,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.provider).toBe(NAVER_API_PROVIDER);
    expect(data.permissionScope).toBe(NAVER_CALL_FAILURE_SCOPE);
    expect(data.success).toBe(false);
    expect(data.statusCode).toBe(429);
    expect(JSON.parse(data.metadata)).toMatchObject({ method: 'GET', retrying: true, attempt: 2 });
  });

  it('기록 실패가 호출부로 전파되지 않는다(P0: 계측이 기능을 깨면 안 된다)', async () => {
    createMock.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      recordNaverCallFailure({
        endpointLabel: '/v1/x', method: 'GET', statusCode: 500,
        message: 'boom', retrying: false, attempt: 1, maxAttempts: 5,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordNaverOperationUsage — 최적화 전후 비교의 정본 지표', () => {
  it('오퍼레이션 1회 = 1행, metadata 에 논리/시도/생략 카운터가 실린다', async () => {
    const t = createNaverCallTally();
    noteNaverLogicalCall(t, 19);
    noteNaverHttpAttempt(t, '/v1/pay-order/seller/product-orders');

    await recordNaverOperationUsage({
      operation: 'confirm_order',
      endpointLabel: '/v1/pay-order/seller/product-orders',
      tally: t,
      success: true,
      elapsedMs: 1234.6,
      context: { campaignId: 'camp_1' },
    });

    const data = createMock.mock.calls[0][0].data;
    expect(data.provider).toBe(NAVER_API_PROVIDER);
    expect(data.permissionScope).toBe(naverOpScope('confirm_order'));
    expect(data.success).toBe(true);
    expect(data.statusCode).toBe(200);
    expect(JSON.parse(data.metadata)).toMatchObject({
      operation: 'confirm_order',
      logicalCalls: 19,
      skipped: 0,
      rateLimitRetries: 0,
      tokenRefreshes: 0,
      elapsedMs: 1235,
      campaignId: 'camp_1',
    });
  });

  it('실패는 statusCode 500 + errorMessage 로 남는다', async () => {
    await recordNaverOperationUsage({
      operation: 'order_excel',
      endpointLabel: '/v1/pay-order/seller/product-orders',
      tally: createNaverCallTally(),
      success: false,
      elapsedMs: 10,
      errorMessage: new Error('주문 조회 실패'),
    });

    const data = createMock.mock.calls[0][0].data;
    expect(data.success).toBe(false);
    expect(data.statusCode).toBe(500);
    expect(data.errorMessage).toContain('주문 조회 실패');
  });

  it('scope 접두사가 오퍼레이션별로 갈린다(월별 집계가 이 값으로 인덱스를 탄다)', () => {
    expect(naverOpScope('confirm_order')).toBe('naver_op_confirm_order');
    expect(naverOpScope('order_excel')).toBe('naver_op_order_excel');
  });

  it('기록 실패가 호출부로 전파되지 않는다', async () => {
    createMock.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      recordNaverOperationUsage({
        operation: 'confirm_order', endpointLabel: '/v1/x',
        tally: createNaverCallTally(), success: true, elapsedMs: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('쓰기 상한 — 기록이 hang 해도 호출부를 잡아두지 않는다', () => {
  // 기록은 apiRequest 의 p-queue 슬롯 안이나 스트림의 controller.close() 직전에서
  // await 된다. 실패가 아니라 **hang** 하면 발주서 작업이 실행시간 한도에 걸리거나
  // 주문확인 버튼이 멈춘다 — 그래서 3초 상한을 두고 초과분은 버린다.
  it('DB 가 응답하지 않아도 상한 안에서 resolve 한다', async () => {
    createMock.mockImplementationOnce(() => new Promise(() => {})); // 영원히 pending
    const started = Date.now();
    await expect(
      recordNaverOperationUsage({
        operation: 'confirm_order', endpointLabel: '/v1/x',
        tally: createNaverCallTally(), success: true, elapsedMs: 1,
      }),
    ).resolves.toBeUndefined();
    // 상한(3s)보다 여유를 두고 확인 — 무한 대기였다면 이 테스트가 타임아웃으로 죽는다.
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10000);

  it('실패 기록도 같은 상한을 받는다', async () => {
    createMock.mockImplementationOnce(() => new Promise(() => {}));
    await expect(
      recordNaverCallFailure({
        endpointLabel: '/v1/x', method: 'GET', statusCode: 500,
        message: 'boom', retrying: false, attempt: 1, maxAttempts: 5,
      }),
    ).resolves.toBeUndefined();
  }, 10000);
});
