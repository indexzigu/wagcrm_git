import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 사후 취소 동기화가 **정산이 시작된 캠페인을 다시 조회하지 않는다**는 계약.
 *
 * 배경(2026-09-09): 이 잡은 마감 후 90일 이내 캠페인의 주문을 **매일 전부 다시** 네이버에
 * 조회했다. 그런데 동결 기준은 마감이 아니라 **정산 락**이라는 것이 오너 확정(2026-07-15)
 * 이라, 이미 정산에 들어간 캠페인은 결과가 바뀔 수 없다 — 그 재조회는 헛일이면서 네이버
 * 호출을 태운다.
 *
 * ⛔ 기준을 정산대기(SETTLEMENT_WAIT)로 앞당기지 말 것 — 그 구간은 반품·구매확정으로
 *    아직 변동한다(오너 확정). 아래 두 번째 케이스가 그것을 고정한다.
 * ⛔ 상태 목록을 이 파일이나 호출부에 베껴 오지 말 것 — 판정은 `isSalesCampaignLocked`
 *    한 곳이다. 이 테스트는 그 함수를 **모킹하지 않고 실제로 태운다.**
 */

const findManyMock = vi.fn();
const updateMock = vi.fn();
const queryOrderDetailsMock = vi.fn();

vi.mock('@/lib/order-converter/prisma', () => ({
  prisma: {
    orderCampaign: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
  },
}));

vi.mock('../naver-order-sync', () => ({
  queryOrderDetails: (...a: unknown[]) => queryOrderDetailsMock(...a),
}));

function campaign(status: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: `oc-${status ?? 'none'}`,
    cachedProductOrderIds: ['po-1', 'po-2'],
    cachedPostCloseCancelQuantity: 0,
    cachedPostCloseCancelRevenue: 0,
    mappings: [],
    name: '테스트 캠페인',
    salesCampaigns: status === null ? [] : [{ status }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  findManyMock.mockReset();
  updateMock.mockReset();
  queryOrderDetailsMock.mockReset();
  queryOrderDetailsMock.mockResolvedValue([]);
});

describe('syncPostCloseCancellations — 정산 락 캠페인 건너뛰기', () => {
  it.each(['SETTLEMENT_IN_PROGRESS', 'COMPLETED', 'DROPPED'])(
    '%s 캠페인은 네이버를 다시 조회하지 않는다',
    async (status) => {
      findManyMock.mockResolvedValue([campaign(status)]);
      const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

      const res = await syncPostCloseCancellations();

      expect(queryOrderDetailsMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ campaigns: 1, skippedLocked: 1, updated: 0 });
    },
  );

  it.each(['SETTLEMENT_WAIT', 'CLOSED', null])(
    '%s 캠페인은 아직 변동하므로 계속 조회한다',
    async (status) => {
      findManyMock.mockResolvedValue([campaign(status)]);
      const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

      const res = await syncPostCloseCancellations();

      expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ skippedLocked: 0 });
    },
  );

  it('includeLocked 면 잠긴 캠페인도 다시 조회한다', async () => {
    // 동결에는 구멍이 있다 — 마감과 정산 시작 사이에 이 잡이 한 번도 못 돌면 값이 0 으로
    // 굳고, 이 함수가 유일한 writer 라 되돌릴 길이 없다. 이 옵션이 그 복구 경로다.
    // ⛔ 지우지 말 것 — 지우면 그 상태가 영구가 된다.
    findManyMock.mockResolvedValue([campaign('SETTLEMENT_IN_PROGRESS')]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations({ includeLocked: true });

    expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ skippedLocked: 0 });
  });

  it('딜이 여럿이면 하나만 정산에 들어가도 건너뛴다', async () => {
    // 집계 창 동결(`campaigns-handler` 의 periodFrozenBySettlement)과 같은 `.some` 기준이다 —
    // 한 캠페인의 딜들은 상태가 함께 움직이고, 정산 무결성 쪽으로 보수적으로 잡는다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', {
        salesCampaigns: [{ status: 'SETTLEMENT_WAIT' }, { status: 'SETTLEMENT_IN_PROGRESS' }],
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ skippedLocked: 1 });
  });
});
