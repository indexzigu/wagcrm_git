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
    cachedPostCloseAllTerminalAt: null,
    // 판매 종료가 이틀 전 — 확인 기간(post-close-check-window.ts, 판매 종료 +15일 안전선) 안이다.
    endDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    salePeriod: null,
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
      { productOrderId: 'po-1', productOrderStatus: 'CANCELED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(res).toMatchObject({ deferredIncomplete: 1, finalizedLocked: 0 });
    // 값은 갱신되고, 마커는 null 로 남는다.
    expect(lastUpdateData()).toMatchObject({ cachedPostCloseCancelQuantity: 1 });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeNull();
  });

  it('응답이 모자라면 이미 확정된 값을 덮지 않는다 — 강제 재계산 경로의 영구 동결 방지', async () => {
    // ⛔ **이 계약을 지우지 말 것.** `includeLocked` 로 재계산하다 응답이 모자랄 때 그대로
    //    쓰면, 온전했던 값이 과소 계상 값으로 바뀌는데 마커는 남아 있어 **다음 회차부터 다시
    //    건너뛴다** — 완전성 게이트가 막으려던 영구 동결이 이 경로로 되살아난다.
    //    (초판은 실제로 값만 쓰고 마커를 보존해 이 구멍을 만들었고, 2회차 리뷰가 잡았다.)
    const marker = new Date('2026-09-01T00:00:00Z');
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', { cachedPostCloseCancelFinalizedAt: marker }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'CANCELED', quantity: 9, totalPaymentAmount: 90000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations({ includeLocked: true });

    expect(updateMock).not.toHaveBeenCalled();
    // ⚠️ 이 경우 레버는 **무위로 끝난다** — 그 사실이 조용히 묻히지 않도록 `deferredIncomplete`
    //    와 **따로** 센다(둘은 배타적이다). 안 가르면 오너가 "갱신됐다"로 오독한다.
    expect(res).toMatchObject({ protectedFinalized: 1, deferredIncomplete: 0, updated: 0 });
  });

  it('id 없는 행은 「돌아온 것」으로 세지 않는다', async () => {
    // 🪤 개수로 재면 id 없는 행이 빠진 id 를 메워 **과소 계상 값이 확정된다.**
    // ⚠️ 이 테스트는 `queryOrderDetails` 를 모킹하므로 **`normalizeQueriedOrder` 를 태우지
    //    않는다** — "id 없는 행이 실제로 배열에 남는다" 는 전제는 `naver-order-sync.test.ts`
    //    의 「`productOrderId` 가 없어도 …」 케이스가 고정한다(4회차 리뷰 지적).
    //    여기서 고정하는 것은 **그런 행이 오면 완전성 판정이 어떻게 되는가** 하나다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', { cachedPostCloseCancelFinalizedAt: null }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
      { productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' }, // id 없음
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(res).toMatchObject({ deferredIncomplete: 1, finalizedLocked: 0 });
  });

  it('락이 아니면 응답이 모자라도 확정 보호를 걸지 않는다 — 값 갱신 + 마커 삭제', async () => {
    // 🪤 상태 격자에서 빠지기 쉬운 칸이다({미락, 확정 마커 있음, 응답 모자람}). 미락이면 값이
    //    애초에 얼어 있지 않으므로 보호할 것이 없고, 마커는 **지워야** 재락 시 확정 계산을 받는다.
    findManyMock.mockResolvedValue([campaign('SETTLEMENT_WAIT')]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'CANCELED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(res).toMatchObject({ protectedFinalized: 0, deferredIncomplete: 0 });
    expect(lastUpdateData().cachedPostCloseCancelFinalizedAt).toBeNull();
    expect(lastUpdateData()).toMatchObject({ cachedPostCloseCancelQuantity: 1 });
  });

  it('빠진 id 를 중복·잉여 행이 가리지 못한다 — 완전성은 개수가 아니라 id 로 판정한다', async () => {
    // 🪤 개수로만 재면 po-1 이 두 번 돌아오고 po-2 가 빠진 응답이 "2건 = 온전" 으로 읽혀
    //    **과소 계상 값이 확정된다.** 그래서 판정은 개수가 아니라 요청 id 집합이다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_IN_PROGRESS', { cachedPostCloseCancelFinalizedAt: null }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
      { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(res).toMatchObject({ deferredIncomplete: 1, finalizedLocked: 0 });
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
      { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).toHaveBeenCalledWith(['po-1']);
    expect(res).toMatchObject({ deferredIncomplete: 0, finalizedLocked: 1 });
  });

  it('확인 기간 판정에 쓰는 필드를 select 에 담고, 후보 창은 90일이 아니라 안전선(+15일) 근처다', async () => {
    // 🪤 `endDate`·`salePeriod`·종결 시각이 select 에서 빠지면 판매 종료일을 몰라 **전부 안전선
    //    중단**(요청 0 — 취소가 조용히 안 잡힌다)이 되는데, 아래 케이스들은 픽스처가 값을 직접 주므로 초록이다.
    findManyMock.mockResolvedValue([]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    await syncPostCloseCancellations();

    const args = findManyMock.mock.calls[0][0] as {
      select: Record<string, unknown>;
      where: { endDate: { gte: Date } };
    };
    expect(args.select).toMatchObject({ endDate: true, salePeriod: true, cachedPostCloseAllTerminalAt: true });
    const floorAgeDays = (Date.now() - args.where.endDate.gte.getTime()) / (24 * 60 * 60 * 1000);
    expect(floorAgeDays).toBeGreaterThan(15);
    expect(floorAgeDays).toBeLessThan(17);
  });
});

describe('syncPostCloseCancellations — 확인 기간(전 주문 종결 +10일 · 판매 종료 +15일, 오너 확정 2026-09-11)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('전 주문 종결을 처음 본 지 10일이 지나면 조회하지 않는다', async () => {
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', {
        endDate: new Date(Date.now() - 13 * DAY),
        cachedPostCloseAllTerminalAt: new Date(Date.now() - 11 * DAY),
      }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ stoppedAfterTerminal: 1, stoppedByBackstop: 0 });
  });

  it('판매 종료 +15일 안전선을 넘으면 종결이 안 보여도 조회하지 않는다', async () => {
    // 탈퇴 구매자 주문이 섞여 응답이 영영 모자란 캠페인이 종전엔 90일 내내 매일 재조회됐다.
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', { endDate: new Date(Date.now() - 16 * DAY) }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(queryOrderDetailsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ stoppedByBackstop: 1 });
  });

  it('온전한 응답이 전부 종결이면 종결 시각을 처음 한 번 찍는다', async () => {
    findManyMock.mockResolvedValue([campaign('SETTLEMENT_WAIT', { cachedPostCloseCancelFinalizedAt: null })]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    expect(lastUpdateData().cachedPostCloseAllTerminalAt).toBeInstanceOf(Date);
    expect(res).toMatchObject({ markedAllTerminal: 1 });
  });

  it('이미 찍힌 종결 시각은 다시 찍지 않는다(+10일 기준점이 밀리지 않게)', async () => {
    const terminalAt = new Date(Date.now() - 3 * DAY);
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', { cachedPostCloseCancelFinalizedAt: null, cachedPostCloseAllTerminalAt: terminalAt }),
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    const res = await syncPostCloseCancellations();

    // 값도 마커도 그대로면 쓰기 자체가 없고, 쓰더라도 시각은 종전 값이어야 한다.
    const written = updateMock.mock.calls.length ? lastUpdateData().cachedPostCloseAllTerminalAt : terminalAt;
    expect(written).toEqual(terminalAt);
    expect(res).toMatchObject({ markedAllTerminal: 0 });
  });

  it('배송완료 뒤 반품 요청이 진행 중이면 종결 시각을 지워 확인을 이어 간다', async () => {
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', {
        cachedPostCloseCancelFinalizedAt: null,
        cachedPostCloseAllTerminalAt: new Date(Date.now() - 3 * DAY),
      }),
    ]);
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'DELIVERED', quantity: 1, productName: 'x' },
      {
        productOrderId: 'po-2',
        productOrderStatus: 'DELIVERED',
        quantity: 1,
        productName: 'x',
        __claim: { return: { claimStatus: 'RETURN_REQUEST', claimQuantity: 1 } },
      },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    await syncPostCloseCancellations();

    expect(lastUpdateData().cachedPostCloseAllTerminalAt).toBeNull();
  });

  it('응답이 모자라면 종결 여부를 판단하지 않는다(찍힌 시각을 그대로 둔다)', async () => {
    const terminalAt = new Date(Date.now() - 3 * DAY);
    findManyMock.mockResolvedValue([
      campaign('SETTLEMENT_WAIT', { cachedPostCloseCancelFinalizedAt: null, cachedPostCloseAllTerminalAt: terminalAt }),
    ]);
    // 2건 요청에 1건(취소)만 온다 — 값은 바뀌므로 쓰기는 일어난다.
    queryOrderDetailsMock.mockResolvedValue([
      { productOrderId: 'po-1', productOrderStatus: 'CANCELED', quantity: 1, totalPaymentAmount: 10000, productName: 'x' },
    ]);
    const { syncPostCloseCancellations } = await import('../naver-settlement-sync');

    await syncPostCloseCancellations();

    expect(lastUpdateData().cachedPostCloseAllTerminalAt).toEqual(terminalAt);
  });
});

describe('syncPostCloseCancellations — select 계약', () => {
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
