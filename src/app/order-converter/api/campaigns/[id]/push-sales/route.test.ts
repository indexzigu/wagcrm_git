import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const orderCampaignFindUniqueMock = vi.fn();
const campaignDealFindManyMock = vi.fn();
const fetchAndSyncCampaignsMock = vi.fn();

vi.mock('@/lib/order-converter/prisma', () => ({
  prisma: {
    orderCampaign: {
      findUnique: (...args: unknown[]) => orderCampaignFindUniqueMock(...args),
    },
    campaignDeal: {
      findMany: (...args: unknown[]) => campaignDealFindManyMock(...args),
    },
  },
}));

vi.mock('../../campaigns-handler', () => ({
  fetchAndSyncCampaigns: (...args: unknown[]) => fetchAndSyncCampaignsMock(...args),
}));

import { POST } from './route';

function makeRequest() {
  return new NextRequest('http://localhost:3000/order-converter/api/campaigns/order-1/push-sales', {
    method: 'POST',
  });
}

const params = { params: Promise.resolve({ id: 'order-1' }) };

beforeEach(() => {
  orderCampaignFindUniqueMock.mockReset();
  campaignDealFindManyMock.mockReset();
  fetchAndSyncCampaignsMock.mockReset();
  campaignDealFindManyMock.mockResolvedValue([
    { id: 'deal-1', campaign: { id: 'sales-1', campaignName: '판매 캠페인', status: 'PROGRESS' } },
    { id: 'deal-2', campaign: { id: 'sales-1', campaignName: '판매 캠페인', status: 'PROGRESS' } },
  ]);
  fetchAndSyncCampaignsMock.mockResolvedValue(NextResponse.json([]));
});

describe('POST /order-converter/api/campaigns/[id]/push-sales', () => {
  it('잠금 상태를 확인한 뒤 해당 주문관리 캠페인만 await 재계산한다', async () => {
    orderCampaignFindUniqueMock
      .mockResolvedValueOnce({
        id: 'order-1',
        mappings: [
          { campaignDealId: 'deal-1', price: 12000 },
          { campaignDealId: 'deal-2', price: 0 },
          { campaignDealId: null, price: 9900 },
        ],
        salesCampaigns: [{ id: 'sales-1', campaignDeals: [] }],
      })
      .mockResolvedValueOnce({
        salesCampaigns: [
          {
            id: 'sales-1',
            campaignName: '판매 캠페인',
            quantity: 3,
            actualSales: 36000,
            campaignDeals: [
              { id: 'deal-1', quantity: 3, actualSales: 36000, sellingPrice: 12000 },
              { id: 'deal-2', quantity: 0, actualSales: 0, sellingPrice: null },
            ],
          },
        ],
      });
    // handler가 매칭된 딜을 outcome에 채운다(두 딜 모두 반영).
    fetchAndSyncCampaignsMock.mockImplementationOnce((_flag: unknown, opts: { salesPushOutcome?: { pushedDealIds: string[] } }) => {
      opts?.salesPushOutcome?.pushedDealIds.push('deal-1', 'deal-2');
      return NextResponse.json([]);
    });

    const res = await POST(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(campaignDealFindManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['deal-1', 'deal-2'] } },
      include: {
        campaign: {
          select: {
            id: true,
            campaignName: true,
            status: true,
          },
        },
      },
    });
    expect(fetchAndSyncCampaignsMock).toHaveBeenCalledWith(false, expect.objectContaining({
      salesPushOrderCampaignId: 'order-1',
      awaitSalesPush: true,
      salesPushOutcome: expect.any(Object),
    }));
    expect(body).toMatchObject({
      success: true,
      pushedCampaigns: 1,
      pushedDeals: 2,
      unmatchedDeals: 0,
    });
  });

  it('매칭 0건 딜은 반영에서 제외하고 unmatched로 보고한다', async () => {
    orderCampaignFindUniqueMock
      .mockResolvedValueOnce({
        id: 'order-1',
        mappings: [
          { campaignDealId: 'deal-1', price: 12000 },
          { campaignDealId: 'deal-2', price: 9900 },
        ],
        salesCampaigns: [{ id: 'sales-1', campaignDeals: [] }],
      })
      .mockResolvedValueOnce({ salesCampaigns: [] });
    // deal-1은 매칭 성공, deal-2는 매칭 0건 → 덮어쓰기 스킵(기존값 보존).
    fetchAndSyncCampaignsMock.mockImplementationOnce((_flag: unknown, opts: { salesPushOutcome?: { pushedDealIds: string[]; unmatchedDealIds: string[] } }) => {
      opts?.salesPushOutcome?.pushedDealIds.push('deal-1');
      opts?.salesPushOutcome?.unmatchedDealIds.push('deal-2');
      return NextResponse.json([]);
    });

    const res = await POST(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      pushedDeals: 1,
      linkedDeals: 2,
      unmatchedDeals: 1,
      unmatchedDealIds: ['deal-2'],
    });
  });

  it('연결된 매핑이 없으면 409를 반환한다', async () => {
    orderCampaignFindUniqueMock.mockResolvedValueOnce({
      id: 'order-1',
      mappings: [{ campaignDealId: null, price: 12000 }],
      salesCampaigns: [],
    });

    const res = await POST(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe('판매관리 캠페인에 연결된 매핑이 없습니다.');
    expect(fetchAndSyncCampaignsMock).not.toHaveBeenCalled();
  });

  it('연결된 판매관리 캠페인이 잠겨 있으면 푸시를 거부한다', async () => {
    orderCampaignFindUniqueMock.mockResolvedValueOnce({
      id: 'order-1',
      mappings: [{ campaignDealId: 'deal-1', price: 12000 }],
    });
    campaignDealFindManyMock.mockResolvedValueOnce([
      { id: 'deal-1', campaign: { id: 'sales-1', campaignName: '마감 캠페인', status: 'COMPLETED' } },
    ]);

    const res = await POST(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('마감 캠페인');
    expect(fetchAndSyncCampaignsMock).not.toHaveBeenCalled();
  });

  it('await 동기화가 실패하면 성공으로 보고하지 않는다', async () => {
    orderCampaignFindUniqueMock.mockResolvedValueOnce({
      id: 'order-1',
      mappings: [{ campaignDealId: 'deal-1', price: 12000 }],
    });
    fetchAndSyncCampaignsMock.mockResolvedValueOnce(NextResponse.json({ error: 'boom' }, { status: 500 }));

    const res = await POST(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('주문 집계 재계산에 실패했습니다.');
  });
});
