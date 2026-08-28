import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ⚠️ 이 라우트는 실 호출 시 고객에게 취소 불가능한 알림을 발송한다.
// 검증은 반드시 apiRequest 모킹으로만 한다(실 productOrderId 호출 금지 — P0).

const apiRequestMock = vi.fn();
const requireAuthMock = vi.fn();
const syncOrdersByIdsMock = vi.fn();

vi.mock('@/lib/order-converter/naver-commerce-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock('@/lib/order-converter/naver-order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-converter/naver-order-sync')>();
  return {
    ...actual,
    syncOrdersByIds: (...args: unknown[]) => syncOrdersByIdsMock(...args),
  };
});

import { POST } from './route';

const FUTURE_DUE = '2099-01-02T23:59:59.000+09:00';

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/order-converter/api/naver/delay-dispatch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function delayReq(productOrderId: string, overrides: Record<string, unknown> = {}) {
  return {
    productOrderId,
    dispatchDueDate: FUTURE_DUE,
    delayedDispatchReason: 'PRODUCT_PREPARE',
    dispatchDelayedDetailedReason: '주문량 증가로 출고가 지연되고 있습니다.',
    ...overrides,
  };
}

/** query API 응답 아이템(사전 상태조회용) */
function queryItem(productOrderId: string, productOrderStatus: string, extra: Record<string, unknown> = {}) {
  return {
    order: { orderId: `ord-${productOrderId}` },
    productOrder: { productOrderId, productOrderStatus },
    ...extra,
  };
}

/** apiRequest 라우팅 목: query는 statusItems 반환, /delay는 delayImpl 위임 */
function mockNaver(statusItems: any[], delayImpl?: (productOrderId: string) => unknown) {
  apiRequestMock.mockImplementation(async (method: string, path: string) => {
    if (path === '/v1/pay-order/seller/product-orders/query') {
      return { data: statusItems };
    }
    const delayMatch = path.match(/product-orders\/([^/]+)\/delay$/);
    if (delayMatch) {
      const id = decodeURIComponent(delayMatch[1]);
      if (delayImpl) return delayImpl(id);
      return { data: { successProductOrderIds: [id] } };
    }
    throw new Error(`unexpected apiRequest: ${method} ${path}`);
  });
}

beforeEach(() => {
  apiRequestMock.mockReset();
  requireAuthMock.mockReset();
  syncOrdersByIdsMock.mockReset();
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { email: 'op@ygrd.kr' } });
  syncOrdersByIdsMock.mockResolvedValue({ updated: 0, affectedDates: [] });
});

describe('POST /order-converter/api/naver/delay-dispatch — 인증·입력 검증', () => {
  it('미인증이면 401 (requireAuth 응답 그대로 반환)', async () => {
    const { NextResponse } = await import('next/server');
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const res = await POST(makeRequest({ requests: [delayReq('p1')] }));
    expect(res.status).toBe(401);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('requests가 없거나 빈 배열이면 400', async () => {
    expect((await POST(makeRequest({}))).status).toBe(400);
    expect((await POST(makeRequest({ requests: [] }))).status).toBe(400);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('유효하지 않은 지연 사유 enum이면 400', async () => {
    const res = await POST(makeRequest({ requests: [delayReq('p1', { delayedDispatchReason: 'HACK' })] }));
    expect(res.status).toBe(400);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('과거 발송예정일이면 400 (고객 알림 전 서버 선차단)', async () => {
    const res = await POST(
      makeRequest({ requests: [delayReq('p1', { dispatchDueDate: '2020-01-01T23:59:59.000+09:00' })] }),
    );
    expect(res.status).toBe(400);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('상세 사유가 비어 있으면 400 (고객 노출 문구)', async () => {
    const res = await POST(makeRequest({ requests: [delayReq('p1', { dispatchDelayedDetailedReason: '  ' })] }));
    expect(res.status).toBe(400);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });
});

describe('사전 필터 (query 상태조회)', () => {
  it('PAYED/PRODUCT_READY만 통과, 그 외 상태·미조회 건은 skip', async () => {
    mockNaver([
      queryItem('p1', 'PAYED'),
      queryItem('p2', 'PRODUCT_READY'),
      queryItem('p3', 'DELIVERING'),
      // p4는 조회 결과 없음 → NOT_FOUND_OR_NO_STATUS
    ]);
    const res = await POST(
      makeRequest({ requests: [delayReq('p1'), delayReq('p2'), delayReq('p3'), delayReq('p4')] }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.successCount).toBe(2);
    expect(body.failCount).toBe(0);
    expect(body.skipCount).toBe(2);
    expect(body.skipped).toContainEqual({ productOrderId: 'p3', reason: 'DELIVERING' });
    expect(body.skipped).toContainEqual({ productOrderId: 'p4', reason: 'NOT_FOUND_OR_NO_STATUS' });

    // /delay는 통과분(p1, p2)에만 건별 호출된다
    const delayCalls = apiRequestMock.mock.calls.filter(([, path]) => String(path).endsWith('/delay'));
    expect(delayCalls.map(([, path]) => path)).toEqual([
      '/v1/pay-order/seller/product-orders/p1/delay',
      '/v1/pay-order/seller/product-orders/p2/delay',
    ]);
    // 요청 바디에 3필드가 그대로 실린다
    expect(delayCalls[0][2]).toEqual({
      dispatchDueDate: FUTURE_DUE,
      delayedDispatchReason: 'PRODUCT_PREPARE',
      dispatchDelayedDetailedReason: '주문량 증가로 출고가 지연되고 있습니다.',
    });
  });

  it('클레임 진행 건은 PAYED여도 skip(reason=CLAIM_IN_PROGRESS), /delay 미호출', async () => {
    mockNaver([
      queryItem('p1', 'PAYED', {
        return: { claimStatus: 'RETURN_REQUEST' },
        currentClaim: { claimType: 'RETURN', claimStatus: 'RETURN_REQUEST' },
      }),
      queryItem('p2', 'PAYED'),
      // 완료된 클레임(RETURN_DONE)은 진행 중이 아니므로 통과되어야 한다
      queryItem('p3', 'PAYED', {
        return: { claimStatus: 'RETURN_DONE' },
        completedClaims: [{ claimType: 'RETURN', claimStatus: 'RETURN_DONE' }],
      }),
    ]);
    const res = await POST(makeRequest({ requests: [delayReq('p1'), delayReq('p2'), delayReq('p3')] }));
    const body = await res.json();

    expect(body.skipped).toContainEqual({ productOrderId: 'p1', reason: 'CLAIM_IN_PROGRESS' });
    expect(body.successCount).toBe(2);
    const delayCalls = apiRequestMock.mock.calls.filter(([, path]) => String(path).endsWith('/delay'));
    expect(delayCalls.some(([, path]) => String(path).includes('/p1/'))).toBe(false);
  });

  it('300건 초과 시 query 상태조회가 300건 청크로 분할된다', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `p${i}`);
    mockNaver(ids.map((id) => queryItem(id, 'PAYED')));
    const res = await POST(makeRequest({ requests: ids.map((id) => delayReq(id)) }));
    expect(res.status).toBe(200);

    const queryCalls = apiRequestMock.mock.calls.filter(
      ([, path]) => path === '/v1/pay-order/seller/product-orders/query',
    );
    expect(queryCalls).toHaveLength(2);
    expect((queryCalls[0][2] as any).productOrderIds).toHaveLength(300);
    expect((queryCalls[1][2] as any).productOrderIds).toHaveLength(1);
  });
});

describe('건별 /delay 호출 집계', () => {
  it('한 건 실패해도 나머지는 계속 처리하고, 성공분만 syncOrdersByIds에 전달한다', async () => {
    mockNaver(
      [queryItem('p1', 'PAYED'), queryItem('p2', 'PAYED'), queryItem('p3', 'PAYED')],
      (id) => {
        if (id === 'p2') throw new Error('네이버 500');
        return { data: { successProductOrderIds: [id] } };
      },
    );
    const res = await POST(makeRequest({ requests: [delayReq('p1'), delayReq('p2'), delayReq('p3')] }));
    const body = await res.json();

    expect(body.successCount).toBe(2);
    expect(body.failCount).toBe(1);
    expect(body.failed).toContainEqual({ productOrderId: 'p2', reason: '네이버 500' });
    expect(body.firstFailReason).toBe('네이버 500');
    expect(syncOrdersByIdsMock).toHaveBeenCalledTimes(1);
    expect(syncOrdersByIdsMock).toHaveBeenCalledWith(['p1', 'p3']);
  });

  it('응답 failProductOrderInfos의 code/message를 실패 사유로 보존한다', async () => {
    mockNaver([queryItem('p1', 'PAYED')], (id) => ({
      data: { failProductOrderInfos: [{ productOrderId: id, code: '104105', message: '이미 발송지연 처리됨' }] },
    }));
    const res = await POST(makeRequest({ requests: [delayReq('p1')] }));
    const body = await res.json();

    expect(body.successCount).toBe(0);
    expect(body.failCount).toBe(1);
    expect(body.failed[0].reason).toBe('104105 이미 발송지연 처리됨');
    expect(syncOrdersByIdsMock).not.toHaveBeenCalled();
  });

  it('전량 스킵이면 /delay를 한 번도 호출하지 않고 syncOrdersByIds도 호출하지 않는다', async () => {
    mockNaver([queryItem('p1', 'DELIVERED')]);
    const res = await POST(makeRequest({ requests: [delayReq('p1')] }));
    const body = await res.json();

    expect(body.successCount).toBe(0);
    expect(body.skipCount).toBe(1);
    const delayCalls = apiRequestMock.mock.calls.filter(([, path]) => String(path).endsWith('/delay'));
    expect(delayCalls).toHaveLength(0);
    expect(syncOrdersByIdsMock).not.toHaveBeenCalled();
  });

  it('syncOrdersByIds 실패는 삼키고(경고만) 집계 응답은 정상 반환한다', async () => {
    syncOrdersByIdsMock.mockRejectedValue(new Error('DB down'));
    mockNaver([queryItem('p1', 'PAYED')]);
    const res = await POST(makeRequest({ requests: [delayReq('p1')] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.successCount).toBe(1);
  });
});
