import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchNaverProductsMock = vi.fn();

vi.mock('@/lib/order-converter/naver-commerce-api', () => ({
  searchNaverProducts: (...args: unknown[]) => searchNaverProductsMock(...args),
}));

import { GET } from './route';

function product(name: string, statusType: string, saleEndDate?: string) {
  return {
    channelProducts: [{ name, statusType, saleEndDate }],
  };
}

beforeEach(() => {
  searchNaverProductsMock.mockReset();
});

describe('GET /order-converter/api/naver/products', () => {
  it('판매중 상품을 그 외 상태보다 앞에 정렬한다', async () => {
    searchNaverProductsMock.mockResolvedValue({
      contents: [
        product('종료상품', 'CLOSE', '2026-09-01T00:00:00.000Z'),
        product('판매중상품', 'SALE', '2026-12-01T00:00:00.000Z'),
      ],
    });

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.products.map((p: any) => p.channelProducts[0].name)).toEqual([
      '판매중상품',
      '종료상품',
    ]);
  });

  it('판매중 상품끼리는 판매 종료일이 빠른 상품을 앞에 정렬한다', async () => {
    searchNaverProductsMock.mockResolvedValue({
      contents: [
        product('늦게종료', 'SALE', '2026-12-31T00:00:00.000Z'),
        product('곧종료', 'SALE', '2026-09-20T00:00:00.000Z'),
      ],
    });

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.products.map((p: any) => p.channelProducts[0].name)).toEqual([
      '곧종료',
      '늦게종료',
    ]);
  });

  it('판매 종료일이 없는 상품은 같은 그룹 내에서 뒤로 밀린다', async () => {
    searchNaverProductsMock.mockResolvedValue({
      contents: [
        product('종료일없음', 'SALE', undefined),
        product('종료일있음', 'SALE', '2026-09-20T00:00:00.000Z'),
      ],
    });

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.products.map((p: any) => p.channelProducts[0].name)).toEqual([
      '종료일있음',
      '종료일없음',
    ]);
  });
});
