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

/**
 * 기본 픽스처는 **이미 계산된** 캠페인이다(취소값이 0 이 아님). 두 값이 모두 0 이면
 * "아직 계산 안 됨"과 구분되지 않아 건너뛰지 않는 것이 계약이므로(아래 별도 케이스),
 * 동결을 검증하려면 값이 있어야 한다.
 */
function campaign(status: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: `oc-${status ?? 'none'}`,
    cachedProductOrderIds: ['po-1', 'po-2'],
    cachedPostCloseCancelQuantity: 3,
    cachedPostCloseCancelRevenue: 30000,
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

  it('잠겼어도 취소값이 아직 0 이면 계속 조회한다', async () => {
    // ⛔ **이 계약을 지우지 말 것 — 지우면 데이터가 영구히 0 으로 굳는다.**
    //    두 필드의 기본값이 0 이라 "계산했는데 취소가 없었다"와 "계산된 적이 없다"를
    //    구분할 수 없다. 마감과 정산 착수를 같은 날 하면 하루 1회인 이 잡이 그 사이에
    //    끼지 못하는데, 이 함수가 유일한 writer 라 되돌릴 길이 없다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedPostCloseCancelQuantity: 0,
        cachedPostCloseCancelRevenue: 0,
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
    // 이 부류만 세는 카운터 — 「수렴하지 않는다」를 배포 후 실측하는 유일한 신호다.
    expect(res).toMatchObject({ skippedLocked: 0, requeriedUncomputed: 1 });
  });

  it('includeLocked 면 잠긴 캠페인도 다시 조회한다', async () => {
    // 0 으로 굳는 구멍은 위 「값이 아직 0 이면 조회한다」 계약이 닫는다. 이 옵션은 **그 위의 수동
    // 레버**다 — 값이 0 이 아닌데 틀린 경우에 다시 계산하려고 쓴다.
    // 호출 경로: `run-cron.sh 'naver-settlement-sync?includeLocked=1'` 또는 수동 curl.
    findManyMock.mockResolvedValue([campaign('SETTLEMENT_IN_PROGRESS')]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations({ includeLocked: true });

    expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ skippedLocked: 0 });
  });

  it('한쪽 값만 0 이면 계산된 것으로 보고 건너뛴다', async () => {
    // 🪤 판정은 **두 값이 모두 0** 일 때만 미계산이다(AND). 수량은 잡히고 금액이 0 이 되는
    //    조합은 **구조적으로 가능하다**(결제액·할인이 0 이면 단가가 매핑 가격으로 떨어지고,
    //    매핑이 없으면 그것도 0 이다 — 프로덕션 실사례를 확인한 것은 아니다).
    //    `||` 로 넓히면 그런 캠페인이 90일 내내 재조회되므로 이 케이스가 경계를 고정한다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedPostCloseCancelQuantity: 2,
        cachedPostCloseCancelRevenue: 0,
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ skippedLocked: 1 });
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
