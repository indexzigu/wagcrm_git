import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 발주요청 미리보기·확정 라우트의 행위 계약(발주 자동화 2단계).
 *
 * 핵심 불변식:
 *  ① 미리보기(GET)는 **네이버에 쓰지 않는다** — 준비본은 네이버 호출 0, 재수집은 조회만.
 *  ② 확정(POST)은 **미리보기 집합 안에서만** 발주확인하고, 재조회 결과로 행을 다시 만든다
 *     (그 사이 취소된 주문은 빠지고 이유가 보고된다).
 *  ③ 판정 근거를 못 읽으면(배송대기 집합·재조회 실패) 발주서를 만들지 않는다 — 빈 값으로 폴백하면
 *     같은 주문이 두 번 발주되거나 취소된 주문이 나간다.
 */

const apiRequestMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const latestChangeCursorMock = vi.fn();
const getPoRequestedSetMock = vi.fn();
const syncOrdersByIdsMock = vi.fn();
const fetchPendingOrderWindowMock = vi.fn();
const generateExcelMock = vi.fn();
const recordUsageMock = vi.fn();
const dailyTaskUpsertMock = vi.fn();
const l1Cache: Record<string, any> = {};

vi.mock('@/lib/order-converter/naver-commerce-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));
vi.mock('@/lib/order-converter/prisma', () => ({
  prisma: {
    orderCampaign: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
    dailyOrderTask: { upsert: (...args: unknown[]) => dailyTaskUpsertMock(...args) },
  },
}));
vi.mock('@/repositories/naverOrderSnapshotRepository', () => ({
  naverOrderSnapshotRepository: {
    latestChangeCursor: (...args: unknown[]) => latestChangeCursorMock(...args),
    findRangeCounts: vi.fn(async () => []),
    findLatestCursor: vi.fn(async () => null),
  },
}));
vi.mock('@/repositories/orderFulfillmentRepository', () => ({
  orderFulfillmentRepository: { getPoRequestedSet: (...args: unknown[]) => getPoRequestedSetMock(...args) },
}));
vi.mock('@/lib/order-converter/naver-order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-converter/naver-order-sync')>();
  return { ...actual, syncOrdersByIds: (...args: unknown[]) => syncOrdersByIdsMock(...args) };
});
vi.mock('@/lib/order-converter/order-fetch-window', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-converter/order-fetch-window')>();
  return { ...actual, fetchPendingOrderWindow: (...args: unknown[]) => fetchPendingOrderWindowMock(...args) };
});
vi.mock('@/lib/order-converter/snapshot-l1-cache', () => ({
  hydrateSnapshotL1: vi.fn(async () => ({ metaCount: 1 })),
  getSnapshotL1Cache: () => l1Cache,
}));
vi.mock('@/lib/order-converter/order-brand', () => ({
  resolveOrderBrand: vi.fn(async () => ({ displayName: '브랜드', excelRules: null })),
  loadOrderTemplateBuffer: vi.fn(async () => undefined),
}));
vi.mock('@/lib/order-converter/excel-generator', () => ({
  generateOrderExcelBuffer: (...args: unknown[]) => generateExcelMock(...args),
}));
vi.mock('@/lib/order-converter/naver-api-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-converter/naver-api-usage')>();
  return { ...actual, recordNaverOperationUsage: (...args: unknown[]) => recordUsageMock(...args) };
});

import { GET, POST } from './route';

const params = Promise.resolve({ id: 'c1' });
const BASE = 'http://localhost:3000/order-converter/api/campaigns/c1/purchase-order';

function flatOrder(id: string, over: Record<string, unknown> = {}) {
  return {
    orderId: `O-${id}`,
    productOrderId: id,
    productOrderStatus: 'PAYED',
    placeOrderStatus: 'NOT_YET',
    productName: '테스트 공구 세트',
    productOption: '블루',
    productId: 'P1',
    quantity: 1,
    paymentDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    shippingAddress: { name: `수령${id}`, tel1: '010', baseAddress: '서울', detailedAddress: '1' },
    ...over,
  };
}

function campaignFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: '테스트 공구',
    template: 'brand-a',
    sellerName: '셀러',
    productId: null,
    autoPrepEnabled: true,
    startDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    endDate: null,
    salePeriod: null,
    salesCampaigns: [],
    mappings: [],
    ...over,
  };
}

function post(body: unknown) {
  return POST(new NextRequest(BASE, { method: 'POST', body: JSON.stringify(body) }), { params });
}

const confirmCalls = () => apiRequestMock.mock.calls.filter((c) => String(c[1]).endsWith('/confirm'));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(l1Cache)) delete l1Cache[k];
  findUniqueMock.mockResolvedValue(campaignFixture());
  findManyMock.mockResolvedValue([{ id: 'c1', name: '테스트 공구' }]);
  latestChangeCursorMock.mockResolvedValue({ lastChangeStatusCursor: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  getPoRequestedSetMock.mockResolvedValue(new Set());
  generateExcelMock.mockResolvedValue(Buffer.from('xlsx'));
  recordUsageMock.mockResolvedValue(undefined);
  dailyTaskUpsertMock.mockResolvedValue({});
  apiRequestMock.mockImplementation(async (_m: string, _path: string, body: any) => ({
    data: { successProductOrderInfos: (body?.productOrderIds ?? []).map((productOrderId: string) => ({ productOrderId })), failProductOrderInfos: [] },
  }));
});

describe('GET 미리보기 — 네이버에 쓰지 않는다', () => {
  it('출처 없이 부르면 준비본 가용성만 돌려준다(네이버 0 · 행 없음)', async () => {
    const res = await GET(new NextRequest(BASE), { params });
    const body = await res.json();
    expect(body.availability).toMatchObject({ available: true });
    expect(body.rows).toBeUndefined();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('준비본은 스냅샷으로 행을 만들고 네이버를 부르지 않는다 — 배송대기는 뺀다', async () => {
    l1Cache[new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)] = {
      lastCallTime: Date.now(),
      orders: [flatOrder('A'), flatOrder('B', { placeOrderStatus: 'OK' }), flatOrder('C')],
    };
    getPoRequestedSetMock.mockResolvedValue(new Set(['C']));
    const res = await GET(new NextRequest(`${BASE}?source=prepared`), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rows.map((r: any) => r.productOrderId)).toEqual(['A', 'B']);
    expect(body.summary).toMatchObject({ lineCount: 2, needsConfirmCount: 1 });
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(fetchPendingOrderWindowMock).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled(); // 네이버 0 이라 계측 행도 만들지 않는다
  });

  it('스위치가 꺼져 있으면 준비본 미리보기를 거절하고 사유를 준다', async () => {
    findUniqueMock.mockResolvedValue(campaignFixture({ autoPrepEnabled: false }));
    const res = await GET(new NextRequest(`${BASE}?source=prepared`), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('꺼져 있습니다');
  });

  it('재수집은 조회만 하고 발주확인은 부르지 않으며, 미리보기 단계로 계측된다', async () => {
    fetchPendingOrderWindowMock.mockResolvedValue({ items: [{ order: flatOrder('A'), productOrder: flatOrder('A') }], integrityIssues: [], failure: null });
    const res = await GET(new NextRequest(`${BASE}?source=live`), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toHaveLength(1);
    expect(confirmCalls()).toHaveLength(0);
    expect(recordUsageMock.mock.calls[0][0]).toMatchObject({ operation: 'order_excel', context: { phase: 'preview', source: 'live' } });
  });

  it('배송대기 집합을 못 읽으면 미리보기를 만들지 않는다(이중 발주 방지)', async () => {
    fetchPendingOrderWindowMock.mockResolvedValue({ items: [{ order: flatOrder('A'), productOrder: flatOrder('A') }], integrityIssues: [], failure: null });
    getPoRequestedSetMock.mockRejectedValue(new Error('db down'));
    const res = await GET(new NextRequest(`${BASE}?source=live`), { params });
    expect(res.status).toBe(500);
  });
});

describe('POST 확정 — 미리보기에서 본 주문 그대로', () => {
  it('발주확인은 미리보기 집합 안의 확인 전 주문만 — 바깥 id 는 보내지 않는다', async () => {
    syncOrdersByIdsMock.mockResolvedValue({ updated: 2, affectedDates: [], orders: [flatOrder('A', { placeOrderStatus: 'OK' }), flatOrder('B', { placeOrderStatus: 'OK' })] });
    const res = await post({ source: 'prepared', productOrderIds: ['A', 'B'], confirmIds: ['A', 'X'], includePending: false });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(confirmCalls().flatMap((c) => (c[2] as any).productOrderIds)).toEqual(['A']);
    expect(syncOrdersByIdsMock).toHaveBeenCalledWith(['A', 'B']);
    expect(body.productOrderIds).toEqual(['A', 'B']);
    expect(Buffer.from(body.fileBase64, 'base64').toString()).toBe('xlsx');
    expect(body.confirm).toMatchObject({ requested: 1, succeeded: 1, failed: 0 });
    expect(recordUsageMock.mock.calls[0][0]).toMatchObject({ context: { phase: 'commit', source: 'prepared' } });
  });

  it('그 사이 취소된 주문과 응답이 없는 주문은 빼고 이유를 보고한다', async () => {
    syncOrdersByIdsMock.mockResolvedValue({
      updated: 2,
      affectedDates: [],
      orders: [flatOrder('A'), flatOrder('B', { productOrderStatus: 'CANCELED' })],
    });
    const res = await post({ source: 'live', productOrderIds: ['A', 'B', 'C'], confirmIds: [], includePending: false });
    const body = await res.json();
    expect(body.productOrderIds).toEqual(['A']);
    expect(body.dropped).toEqual([
      { productOrderId: 'B', recipientName: '수령B', reason: 'status-changed' },
      { productOrderId: 'C', recipientName: '', reason: 'not-returned' },
    ]);
    const excelOrders = generateExcelMock.mock.calls[0][0].orders.map((o: any) => o.상품주문번호);
    expect(excelOrders).toEqual(['A']);
  });

  it('발주확인 실패로 집계됐어도 재조회에서 이미 확인된 주문은 실패로 세지 않는다', async () => {
    apiRequestMock.mockResolvedValue({ data: { successProductOrderInfos: [], failProductOrderInfos: [{ productOrderId: 'A', message: '이미 발주확인' }, { productOrderId: 'B', message: '오류' }] } });
    syncOrdersByIdsMock.mockResolvedValue({
      updated: 2,
      affectedDates: [],
      orders: [flatOrder('A', { placeOrderStatus: 'OK' }), flatOrder('B', { placeOrderStatus: 'NOT_YET' })],
    });
    const body = await (await post({ source: 'prepared', productOrderIds: ['A', 'B'], confirmIds: ['A', 'B'] })).json();
    expect(body.confirm).toMatchObject({ requested: 2, failed: 1 });
  });

  it('재조회가 실패하면 발주서를 만들지 않는다(미리보기 시점 데이터로 보내지 않는다)', async () => {
    syncOrdersByIdsMock.mockRejectedValue(new Error('timeout'));
    const res = await post({ source: 'prepared', productOrderIds: ['A'], confirmIds: ['A'] });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('발주확인은 1건 처리됐습니다');
    expect(generateExcelMock).not.toHaveBeenCalled();
  });

  it('보낼 주문이 하나도 안 남으면 409 이고 발주서를 만들지 않는다', async () => {
    syncOrdersByIdsMock.mockResolvedValue({ updated: 1, affectedDates: [], orders: [flatOrder('A', { productOrderStatus: 'CANCELED' })] });
    const res = await post({ source: 'prepared', productOrderIds: ['A'], confirmIds: [] });
    expect(res.status).toBe(409);
    expect(generateExcelMock).not.toHaveBeenCalled();
  });

  it('주문 목록이나 출처가 없으면 네이버를 부르기 전에 거절한다', async () => {
    expect((await post({ source: 'prepared', productOrderIds: [] })).status).toBe(400);
    expect((await post({ productOrderIds: ['A'] })).status).toBe(400);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });
});
