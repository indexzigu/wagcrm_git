import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const apiRequestMock = vi.fn();
const syncOrdersByIdsMock = vi.fn();
const runSyncMock = vi.fn();
const markDirtyMock = vi.fn();

vi.mock('@/lib/order-converter/naver-commerce-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

vi.mock('@/lib/order-converter/naver-order-sync', () => ({
  syncOrdersByIds: (...args: unknown[]) => syncOrdersByIdsMock(...args),
  runSync: (...args: unknown[]) => runSyncMock(...args),
}));

vi.mock('@/repositories/naverOrderSnapshotRepository', () => ({
  naverOrderSnapshotRepository: {
    markDirty: (...args: unknown[]) => markDirtyMock(...args),
  },
}));

import { POST } from './route';

function makeRequest(dispatchRequests: unknown[]) {
  return new NextRequest('http://localhost:3000/order-converter/api/naver/dispatch', {
    method: 'POST',
    body: JSON.stringify({ dispatchRequests }),
    headers: { 'Content-Type': 'application/json' },
  });
}

function dispatchReq(productOrderId: string) {
  return {
    productOrderId,
    deliveryMethod: 'DELIVERY',
    deliveryCompanyCode: 'CJGLS',
    trackingNumber: `trk-${productOrderId}`,
    dispatchDate: '2026-07-13T09:00:00.000Z',
  };
}

function queryItem(productOrderId: string, productOrderStatus: string) {
  return {
    order: { orderId: `ord-${productOrderId}`, paymentDate: '2026-07-13T01:00:00.000Z' },
    productOrder: { productOrderId, productOrderStatus },
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  syncOrdersByIdsMock.mockReset();
  runSyncMock.mockReset();
  markDirtyMock.mockReset();
  syncOrdersByIdsMock.mockResolvedValue({ updated: 0, affectedDates: [] });
  runSyncMock.mockResolvedValue({ skipped: false });
  markDirtyMock.mockResolvedValue({ count: 0 });
});

describe('POST /order-converter/api/naver/dispatch', () => {
  it('전량 이미 배송중이면 발송 API는 건너뛰되 해당 주문을 즉시 스냅샷 재조회한다', async () => {
    apiRequestMock.mockResolvedValue({
      data: [queryItem('p1', 'DELIVERING'), queryItem('p2', 'DELIVERING')],
    });

    const res = await POST(makeRequest([dispatchReq('p1'), dispatchReq('p2')]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.successCount).toBe(0);
    expect(body.failCount).toBe(0);
    expect(body.skipCount).toBe(2);
    expect(body.skipped).toEqual([
      { productOrderId: 'p1', reason: 'DELIVERING' },
      { productOrderId: 'p2', reason: 'DELIVERING' },
    ]);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(syncOrdersByIdsMock).toHaveBeenCalledWith(['p1', 'p2']);
    // 정밀 갱신이 성공했으면 그 날짜는 이미 isDirty:false 로 재기록됐다 — 다시 찍으면 자기 갱신을 되돌린다.
    expect(markDirtyMock).not.toHaveBeenCalled();
    expect(runSyncMock).toHaveBeenCalledWith('CHANGED');
  });

  it('정밀 갱신(syncOrdersByIds)이 실패하면 아는 날짜만 dirty 로 폴백한다', async () => {
    apiRequestMock.mockResolvedValue({
      data: [queryItem('p1', 'DELIVERING'), queryItem('p2', 'DELIVERING')],
    });
    syncOrdersByIdsMock.mockRejectedValue(new Error('naver query 실패'));

    const res = await POST(makeRequest([dispatchReq('p1'), dispatchReq('p2')]));

    expect(res.status).toBe(200);
    // 결제일자(2026-07-13T01:00Z = KST 10:00)에서 파생된 날짜 1개만 — 30일 창 전체가 아니다.
    expect(markDirtyMock).toHaveBeenCalledWith(['2026-07-13']);
  });

  it('발송 성공분과 레이스 재분류분을 함께 스냅샷 재조회한다', async () => {
    apiRequestMock.mockImplementation(async (_method: string, path: string, body: any) => {
      if (path === '/v1/pay-order/seller/product-orders/query') {
        const ids = body.productOrderIds as string[];
        if (ids.length === 1 && ids[0] === 'p2') return { data: [queryItem('p2', 'DELIVERING')] };
        return { data: [queryItem('p1', 'PAYED'), queryItem('p2', 'PAYED')] };
      }
      if (path === '/v1/pay-order/seller/product-orders/dispatch') {
        return {
          data: {
            successProductOrderInfos: [{ productOrderId: 'p1' }],
            failProductOrderInfos: [{ productOrderId: 'p2', code: '9999', message: '주문상태 확인' }],
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    const res = await POST(makeRequest([dispatchReq('p1'), dispatchReq('p2')]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.successCount).toBe(1);
    expect(body.failCount).toBe(0);
    expect(body.skipCount).toBe(1);
    expect(syncOrdersByIdsMock).toHaveBeenCalledWith(['p1', 'p2']);
  });
});
