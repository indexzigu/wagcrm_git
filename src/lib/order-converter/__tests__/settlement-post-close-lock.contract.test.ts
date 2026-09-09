import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 사후 취소 동기화가 **정산이 확정된 캠페인을 다시 조회하지 않는다**는 계약.
 *
 * 배경(#48, 2026-09-09): 이 잡은 마감 후 90일 이내 캠페인의 주문을 **매일 전부 다시**
 * 네이버에 조회했다. 동결 기준은 마감이 아니라 **정산 락**이라는 것이 오너 확정
 * (2026-07-15)이라, 이미 정산에 들어간 캠페인의 재조회는 헛일이면서 네이버 호출을 태운다.
 *
 * 개정(T-140): 확정 여부를 **`cachedPostCloseCancelFinalizedAt` 마커**가 답한다.
 * 종전에는 「두 값이 모두 0 이면 아직 계산 안 된 것으로 본다」는 값 기반 판별을 썼는데,
 * `@default(0)` 이라 "계산했는데 0" 과 구분되지 않아 한계 셋을 남겼다 —
 * ①동결 시점이 부분집합마다 달랐고 ②취소가 0 인 캠페인은 수렴하지 않았으며
 * ③컷오프가 「직전 크론 실행」이라 락 직전 취소를 놓쳤다(취소 과소 계상).
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
 * 기본 픽스처는 **이미 확정된** 캠페인이다(마커 있음). 마커가 없으면 락이어도 한 번은
 * 계산하는 것이 계약이므로(아래 「확정 계산」 케이스), 동결을 검증하려면 마커가 있어야 한다.
 */
function campaign(status: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: `oc-${status ?? 'none'}`,
    cachedProductOrderIds: ['po-1', 'po-2'],
    cachedPostCloseCancelQuantity: 3,
    cachedPostCloseCancelRevenue: 30000,
    cachedPostCloseCancelFinalizedAt: new Date('2026-09-01T00:00:00Z'),
    mappings: [],
    name: '테스트 캠페인',
    salesCampaigns: status === null ? [] : [{ status }],
    ...overrides,
  };
}

/** 마지막 update 호출에 실린 data. */
function lastUpdateData(): Record<string, unknown> {
  const call = updateMock.mock.calls.at(-1);
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

/**
 * 취소가 없는 **온전한** 응답(요청 2건 → 2건). 확정은 "요청한 주문이 전부 돌아왔는가" 를
 * 전제로 하므로, 기본 응답이 빈 배열이면 모든 확정 케이스가 「응답 모자람」으로 빠진다.
 */
function completeOrders() {
  return [
    { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
    { productOrderId: 'po-2', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
  ];
}

beforeEach(() => {
  vi.resetModules();
  findManyMock.mockReset();
  updateMock.mockReset();
  queryOrderDetailsMock.mockReset();
  queryOrderDetailsMock.mockResolvedValue(completeOrders());
});

describe('syncPostCloseCancellations — 확정된 캠페인 건너뛰기', () => {
  it.each(['SETTLEMENT_IN_PROGRESS', 'COMPLETED', 'DROPPED'])(
    '%s 이고 확정 마커가 있으면 네이버를 다시 조회하지 않는다',
    async (status) => {
      findManyMock.mockResolvedValue([campaign(status)]);
      const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

      const res = await syncPostCloseCancellations();

      expect(queryOrderDetailsMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ campaigns: 1, skippedLocked: 1, updated: 0, finalizedLocked: 0 });
    },
  );

  it.each(['SETTLEMENT_WAIT', 'CLOSED', null])(
    '%s 캠페인은 아직 변동하므로 마커와 무관하게 계속 조회한다',
    async (status) => {
      findManyMock.mockResolvedValue([campaign(status)]);
      const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

      const res = await syncPostCloseCancellations();

      expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ skippedLocked: 0 });
    },
  );

  it('잠겼는데 마커가 없으면 「확정 계산」을 한 번 하고 마커를 찍는다', async () => {
    // ⛔ **이 계약을 지우지 말 것.** 이 한 번의 계산이 락 **이후**에 돌기 때문에
    //    「직전 크론 실행 ~ 락」 사이에 들어온 취소가 값에 담긴다 — 락 전이 훅 없이
    //    한계 ③(취소 과소 계상)을 닫는 것이 정확히 이 실행이다.
    //    ⚠️ 이 두 값은 정산 금액 계산이 아니라 마감 캠페인 리포트의 **표시**에 쓰인다
    //    (실측 2026-09-09) — 「정산액 과대」로 서술하지 말 것.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', { cachedPostCloseCancelFinalizedAt: null }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ skippedLocked: 0, finalizedLocked: 1 });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeInstanceOf(Date);
  });

  it('확정 계산의 값이 종전과 같아도 마커를 찍는다 — 안 찍으면 수렴하지 않는다', async () => {
    // 🪤 종전 결함의 핵심이 여기였다: 쓰기 조건이 「값이 바뀌었는가」 하나면, 취소가 정말
    //    0 인 캠페인은 값이 영원히 그대로라 90일 창이 끝날 때까지 매일 재조회된다.
    //    조회 결과가 없어(취소 0) 값이 안 바뀌는 상황을 그대로 재현한다.
    findManyMock.mockResolvedValue([
      campaign('COMPLETED', {
        cachedPostCloseCancelQuantity: 0,
        cachedPostCloseCancelRevenue: 0,
        cachedPostCloseCancelFinalizedAt: null,
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(lastUpdateData()).toMatchObject({
      cachedPostCloseCancelQuantity: 0,
      cachedPostCloseCancelRevenue: 0,
    });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeInstanceOf(Date);
    // 값은 안 바뀌었으므로 `updated` 는 0 이어야 한다(종전 실행과의 비교 가능성 유지).
    expect(res).toMatchObject({ updated: 0, finalizedLocked: 1 });
  });

  it('값이 0 이어도 확정 마커가 있으면 건너뛴다 — 값 기반 판별로 되돌리지 말 것', async () => {
    // ⛔ 이것이 T-140 이 바꾼 지점이다. 종전에는 두 값이 0 이면 "계산된 적 없음" 으로 보고
    //    락이어도 계속 조회했다 — 취소가 진짜 0 인 캠페인이 수렴하지 못한 원인이다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedPostCloseCancelQuantity: 0,
        cachedPostCloseCancelRevenue: 0,
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ skippedLocked: 1 });
  });

  it('락이 풀리면 마커를 지운다 — 안 지우면 다시 락될 때 확정 계산이 없다', async () => {
    // 🪤 상태를 되돌리는 조작이 있으므로(드랍 해제 등) 마커가 남으면 그 캠페인은 재락 시
    //    곧바로 건너뛰기 대상이 되어 옛 값으로 굳는다.
    findManyMock.mockResolvedValue([campaign('SETTLEMENT_WAIT')]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    await syncPostCloseCancellations();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeNull();
  });

  it('주문 목록이 비면 계산도 확정도 하지 않는다', async () => {
    // 🪤 "주문 0 건" 과 "마감 스냅샷이 주문을 못 담았다" 는 구분되지 않는다 — 그 상태로
    //    확정하면 0 이 영구가 되고 유일 writer 라 되돌릴 길이 없다. 네이버 호출이 0 이라
    //    매일 재평가해도 비용이 없으므로 확정을 미루는 쪽이 안전하다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedPostCloseCancelFinalizedAt: null,
        cachedProductOrderIds: [],
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ finalizedLocked: 0, skippedLocked: 0 });
  });

  it('includeLocked 면 확정된 캠페인도 다시 조회한다', async () => {
    // 확정된 값이 틀렸다고 판단될 때 쓰는 **수동 레버**다(0 으로 굳는 구멍은 마커가 닫는다).
    // 호출 경로: `run-cron.sh 'naver-settlement-sync?includeLocked=1'` 또는 수동 curl.
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

  it('응답이 요청보다 모자라면 값은 쓰되 확정은 미룬다', async () => {
    // ⛔ **이 계약을 지우지 말 것.** `queryOrderDetails` 는 응답이 모자라도 console.warn 만
    //    남기고 짧은 배열을 돌려준다. 그 결과로 확정하면 일시적 API 저하가 과소 계상된 값을
    //    **영구히 동결**시키고, 유일 writer 라 수동 레버 말고는 복구 경로가 없다.
    //    값을 쓰는 것은 유지한다 — 부분 응답이라도 지금 알 수 있는 최선이고, 탈퇴 구매자
    //    주문이 섞인 캠페인은 그러지 않으면 영영 값을 못 갖는다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedProductOrderIds: ['po-1', 'po-2'],
        cachedPostCloseCancelFinalizedAt: null,
      }),
    ]);
    // 2건을 요청했는데 1건만 돌아온다(취소 1건).
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderStatus: 'CANCELED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(res).toMatchObject({ deferredIncomplete: 1, finalizedLocked: 0 });
    // 값은 갱신되고, 마커는 null 로 남는다.
    expect(lastUpdateData()).toMatchObject({ cachedPostCloseCancelQuantity: 1 });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeNull();
  });

  it('응답이 모자라도 이미 있던 확정 마커를 지우지 않는다', async () => {
    // 🪤 `includeLocked` 로 재계산하다 응답이 모자라면, 미확정으로 되돌리는 것이 아니라
    //    **기존 확정 시각을 보존**해야 한다(안 그러면 그 캠페인이 다시 매일 조회 대상이 된다).
    const marker = new Date('2026-09-01T00:00:00Z');
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', { cachedPostCloseCancelFinalizedAt: marker }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderStatus: 'CANCELED', quantity: 9, totalPaymentAmount: 90000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations({ includeLocked: true });

    expect(res).toMatchObject({ deferredIncomplete: 1 });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toEqual(marker);
  });

  it('중복 주문 id 는 접어서 완전성을 판정한다 — 안 접으면 영영 확정되지 않는다', async () => {
    // 🪤 `cachedProductOrderIds` 에 같은 id 가 두 번 들어 있으면 응답은 1건이라, 접지 않으면
    //    분모가 부풀어 **완전한 응답도 「모자람」으로 읽힌다**(수렴 실패).
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', {
        cachedProductOrderIds: ['po-1', 'po-1'],
        cachedPostCloseCancelFinalizedAt: null,
      }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderStatus: 'DELIVERED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).toHaveBeenCalledWith(['po-1']);
    expect(res).toMatchObject({ deferredIncomplete: 0, finalizedLocked: 1 });
  });

  it('확정 마커를 조회 select 에 담는다 — 빠지면 전부 미확정으로 읽혀 건너뛰기가 죽는다', async () => {
    // 🪤 `select` 에서 이 필드가 빠지면 값이 항상 `undefined` 라 **모든 락 캠페인이 매일
    //    재조회**되는데, 위 케이스들은 픽스처가 값을 직접 주므로 전부 초록이다.
    findManyMock.mockResolvedValue([]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    await syncPostCloseCancellations();

    const args = findManyMock.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(args.select.cachedPostCloseCancelFinalizedAt).toBe(true);
  });
});
