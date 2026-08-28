import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  orderToDateKey,
  countStatuses,
  normalizeQueriedOrder,
  mergeOrdersByProductOrderId,
  isSnapshotStale,
  toDateKeyKst,
  runSync,
  runChangedSync,
  runFullSync,
  syncOrdersByIds,
} from '../naver-order-sync';

/**
 * ⏰ 고정 날짜 픽스처를 쓰는 describe 전용 시각 고정.
 *
 * 동기화 경로는 보존 창(`SNAPSHOT_WINDOW_DAYS`=30)을 **시스템 시각 기준**으로 잘라낸다.
 * 그래서 `2026-07-01` 같은 **고정** 날짜 픽스처는 실제 시각이 흐르면 창 밖으로 밀려나
 * 코드 변경 없이 깨지는 시한폭탄이 된다.
 *
 * 실제로 터졌다(2026-08-01 KST 자정): 07-31 23:44 KST 의 CI 는 통과하고 00:15 KST 는
 * 실패했으며 그 사이 코드 변경은 문서 1줄뿐이었다. 30일 창의 시작 날짜키가 '2026-07-01'
 * → '2026-07-02' 로 넘어가며 `snapshotDate: '2026-07-01'` 픽스처가 창 밖이 된 것이다.
 * `test` 는 required 체크라 이 시점부터 **모든 PR 의 머지가 막혔다**.
 *
 * ⚠️ **파일 전역에 걸지 말 것.** 나머지 describe 는 `Date.now() - N일` 로 픽스처를 만드는
 * (= 시각 변화에 원래 안전한) 패턴이고, 그 계산은 describe 본문 = **collection 시점**에
 * 실제 시각으로 평가된다. 전역 고정은 그 값들을 "미래 날짜"로 만들어 멀쩡한 테스트를
 * 깨뜨린다(이 수정 중 실제로 2건이 그렇게 깨졌다).
 *
 * `toFake: ['Date']` 로 Date 만 고정한다 — setTimeout 까지 가짜로 만들면 동기화 경로의
 * in-flight dedupe·쿨다운이 진행되지 않고 멈춘다.
 */
function useFixedClockForFixedDateFixtures() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-10T03:00:00.000Z')); // KST 07-10 12:00 — 전 픽스처가 창 안
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

describe('orderToDateKey', () => {
  it('paymentDate를 우선 사용해 KST 날짜키를 계산한다', () => {
    // paymentDate가 UTC 자정 직후(=KST 오전 9시)라면 같은 날짜여야 한다
    const order = { paymentDate: '2026-07-04T00:30:00.000Z' };
    expect(orderToDateKey(order)).toBe('2026-07-04');
  });

  it('UTC 23시 주문은 KST로 다음날로 귀속된다 (자정 경계)', () => {
    // UTC 23:00 = KST 익일 08:00
    const order = { paymentDate: '2026-07-04T23:00:00.000Z' };
    expect(orderToDateKey(order)).toBe('2026-07-05');
  });

  it('paymentDate가 없으면 orderDate로 폴백한다', () => {
    const order = { orderDate: '2026-07-04T01:00:00.000Z' };
    expect(orderToDateKey(order)).toBe('2026-07-04');
  });

  it('paymentDate, orderDate가 모두 없으면 orderCreateDate로 폴백한다', () => {
    const order = { orderCreateDate: '2026-07-04T01:00:00.000Z' };
    expect(orderToDateKey(order)).toBe('2026-07-04');
  });

  it('날짜 정보가 전혀 없으면 null을 반환한다', () => {
    expect(orderToDateKey({})).toBeNull();
  });
});

describe('countStatuses', () => {
  it('PAYED/PRODUCT_ORDERED/PRODUCT_READY를 new로, DISPATCH_WAIT를 preparing으로, DISPATCHED/DELIVERING을 delivering으로 집계한다', () => {
    const orders = [
      { productOrderStatus: 'PAYED' },
      { productOrderStatus: 'PRODUCT_ORDERED' },
      { productOrderStatus: 'DISPATCH_WAIT' },
      { productOrderStatus: 'DISPATCHED' },
      { productOrderStatus: 'DELIVERING' },
      { productOrderStatus: 'DELIVERED' }, // 집계 대상 아님
      { productOrderStatus: 'CANCELED' }, // 집계 대상 아님
    ];
    const result = countStatuses(orders);
    expect(result).toEqual({ newOrdersCount: 2, preparingCount: 1, deliveringCount: 2 });
  });

  it('PRODUCT_READY도 new로 센다 — 발주 조회 생략 게이트가 이 값을 근거로 쓴다', () => {
    // 이게 빠져 있으면 PRODUCT_READY 만 남은 날짜가 "발주 대상 0"으로 보여 발주서에서
    // 누락된다(P0). 실측 관측은 0건이지만 dispatch 라우트가 실제로 취급하는 상태다.
    expect(countStatuses([{ productOrderStatus: 'PRODUCT_READY' }])).toEqual({
      newOrdersCount: 1,
      preparingCount: 0,
      deliveringCount: 0,
    });
  });

  it('빈 배열이면 전부 0이다', () => {
    expect(countStatuses([])).toEqual({ newOrdersCount: 0, preparingCount: 0, deliveringCount: 0 });
  });
});

describe('mergeOrdersByProductOrderId', () => {
  it('같은 productOrderId는 교체된다', () => {
    const existing = [
      { productOrderId: 'A', productOrderStatus: 'PAYED' },
      { productOrderId: 'B', productOrderStatus: 'PAYED' },
    ];
    const changed = [{ productOrderId: 'A', productOrderStatus: 'DISPATCHED' }];
    const merged = mergeOrdersByProductOrderId(existing, changed);
    expect(merged).toHaveLength(2);
    expect(merged.find((o) => o.productOrderId === 'A')?.productOrderStatus).toBe('DISPATCHED');
    expect(merged.find((o) => o.productOrderId === 'B')?.productOrderStatus).toBe('PAYED');
  });

  it('새로운 productOrderId는 추가된다', () => {
    const existing = [{ productOrderId: 'A', productOrderStatus: 'PAYED' }];
    const changed = [{ productOrderId: 'C', productOrderStatus: 'PAYED' }];
    const merged = mergeOrdersByProductOrderId(existing, changed);
    expect(merged).toHaveLength(2);
    expect(merged.map((o) => o.productOrderId).sort()).toEqual(['A', 'C']);
  });

  it('existing이 빈 배열이어도 동작한다', () => {
    const merged = mergeOrdersByProductOrderId([], [{ productOrderId: 'X' }]);
    expect(merged).toHaveLength(1);
  });
});

describe('isSnapshotStale', () => {
  it('forceRefresh가 true면 항상 stale이다', () => {
    expect(isSnapshotStale({ lastCallTime: Date.now() }, new Date(), true)).toBe(true);
  });

  it('meta가 없으면 stale이다', () => {
    expect(isSnapshotStale(null, new Date(), false)).toBe(true);
  });

  it('isDirty면 stale이다', () => {
    expect(isSnapshotStale({ lastCallTime: Date.now(), isDirty: true }, new Date(), false)).toBe(true);
  });

  it('당일 데이터는 1분 이상 지나면 stale이다', () => {
    const now = new Date();
    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    expect(isSnapshotStale({ lastCallTime: twoMinAgo }, now, false)).toBe(true);
    expect(isSnapshotStale({ lastCallTime: Date.now() }, now, false)).toBe(false);
  });

  it('신규주문 방치 건은 5분 기준으로 stale 판정한다', () => {
    const targetDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2일 전
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    expect(isSnapshotStale({ lastCallTime: sixMinAgo, newOrdersCount: 1 }, targetDate, false)).toBe(true);
    expect(isSnapshotStale({ lastCallTime: Date.now(), newOrdersCount: 1 }, targetDate, false)).toBe(false);
  });

  it('14일 이상 지난 오래된 날짜는 72시간 기준이다', () => {
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const almostFresh = Date.now() - 1 * 60 * 60 * 1000; // 1시간 전
    expect(isSnapshotStale({ lastCallTime: almostFresh }, oldDate, false)).toBe(false);
  });
});

describe('normalizeQueriedOrder', () => {
  it('order/productOrder를 평면 병합하고 __claim에 클레임 데이터를 보존한다', () => {
    const dataItem = {
      order: { orderId: 'O1', paymentDate: '2026-07-04T00:00:00.000Z' },
      productOrder: { productOrderId: 'P1', productOrderStatus: 'PAYED', productName: '상품A', productOption: '옵션1', productId: 'PID1', totalPaymentAmount: 10000, quantity: 1, placeOrderStatus: 'NOT_YET' },
      return: { returnReason: '단순변심' },
      currentClaim: { claimType: 'RETURN' },
      beforeClaim: null,
      completedClaims: [{ claimType: 'CANCEL' }],
    };

    const result = normalizeQueriedOrder(dataItem);

    expect(result.orderId).toBe('O1');
    expect(result.productOrderId).toBe('P1');
    expect(result.productOrderStatus).toBe('PAYED');
    expect(result.productName).toBe('상품A');
    expect(result.productOption).toBe('옵션1');
    expect(result.productId).toBe('PID1');
    expect(result.paymentDate).toBe('2026-07-04T00:00:00.000Z');
    expect(result.totalPaymentAmount).toBe(10000);
    expect(result.quantity).toBe(1);
    expect(result.placeOrderStatus).toBe('NOT_YET');

    expect(result.__claim.return).toEqual({ returnReason: '단순변심' });
    expect(result.__claim.currentClaim).toEqual({ claimType: 'RETURN' });
    expect(result.__claim.beforeClaim).toBeNull();
    expect(result.__claim.completedClaims).toEqual([{ claimType: 'CANCEL' }]);
  });

  it('productOrder가 없으면 null을 반환한다 (방어적 처리)', () => {
    expect(normalizeQueriedOrder({ order: {} })).toBeNull();
    expect(normalizeQueriedOrder(null)).toBeNull();
  });

  it('클레임 필드가 전부 없어도 옵셔널 체이닝으로 안전하게 처리된다', () => {
    const dataItem = { order: {}, productOrder: { productOrderId: 'P2' } };
    const result = normalizeQueriedOrder(dataItem);
    expect(result.__claim).toEqual({
      cancel: null,
      return: null,
      exchange: null,
      beforeClaim: null,
      currentClaim: null,
      completedClaims: null,
    });
  });
});

describe('toDateKeyKst', () => {
  it('UTC 시각을 KST 날짜키로 변환한다', () => {
    expect(toDateKeyKst(new Date('2026-07-04T16:00:00.000Z'))).toBe('2026-07-05'); // KST 익일 01:00
    expect(toDateKeyKst(new Date('2026-07-04T00:00:00.000Z'))).toBe('2026-07-04'); // KST 09:00
  });
});

describe('runSync dedup', () => {
  beforeEach(() => {
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
  });

  it('동시에 두 번 호출하면 동일한 in-flight Promise를 공유한다', async () => {
    // repo 의존성을 모킹해 실제 네트워크/DB 접근 없이 dedup 로직만 검증한다.
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockImplementation(async () => {
      // 인위적 지연을 둬서 두 번째 호출이 in-flight 상태를 관측하게 한다.
      await new Promise((r) => setTimeout(r, 20));
      return null;
    });
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    vi.spyOn(clientModule, 'apiRequest').mockResolvedValue({ data: { lastChangeStatuses: [] } });

    // runSync 자체는 async 함수라 호출마다 새 Promise 래퍼가 생기지만,
    // 내부적으로는 동일한 globalThis.__naverSyncInFlight 작업을 공유해야 한다.
    // apiRequest가 정확히 1회만 호출되는지로 dedup(작업 공유)을 검증한다.
    const p1 = runSync('CHANGED');
    const p2 = runSync('CHANGED');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.fetchedAt).toBe(r2.fetchedAt);
    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(false);
    expect(clientModule.apiRequest).toHaveBeenCalledTimes(1);
  });

  it('쿨다운 기간 내 재호출은 skipped:true를 반환한다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    vi.spyOn(clientModule, 'apiRequest').mockResolvedValue({ data: { lastChangeStatuses: [] } });
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);

    const first = await runSync('CHANGED');
    expect(first.skipped).toBe(false);

    const second = await runSync('CHANGED');
    expect(second.skipped).toBe(true);
  });
});

describe('runChangedSync 커서 원자성 (M1/M2 회귀)', () => {
  useFixedClockForFixedDateFixtures(); // 픽스처가 2026-07-01 고정 — 보존 창 밖으로 밀리지 않게

  beforeEach(() => {
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
  });

  it('다중 날짜 중 하나의 upsert가 실패하면 커서를 전진시키지 않는다 (M1)', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    // 변경피드는 2건의 productOrderId를 반환하고, query 상세 조회는 서로 다른 날짜에
    // 귀속되는 2건의 주문을 반환하게 해 ordersByDate가 2개 날짜로 갈리게 만든다.
    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_method: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: '1' }, { productOrderId: '2' }] } };
      }
      if (path.includes('/query')) {
        return {
          data: [
            {
              order: { paymentDate: '2026-07-01T01:00:00.000Z' },
              productOrder: { productOrderId: '1', productOrderStatus: 'PAYED' },
            },
            {
              order: { paymentDate: '2026-07-02T01:00:00.000Z' },
              productOrder: { productOrderId: '2', productOrderStatus: 'PAYED' },
            },
          ],
        };
      }
      return { data: {} };
    });

    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);

    const upsertSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily')
      .mockImplementation(async (input: any) => {
        // 두 번째 날짜(2026-07-02)의 upsert만 실패시켜 부분 실패를 재현한다.
        if (input.snapshotDate === '2026-07-02') {
          throw new Error('DB write failed for 2026-07-02');
        }
        return {} as any;
      });

    const result = await runChangedSync();

    // 실패가 있었으므로 커서는 전진하지 않아야 한다.
    expect(result.cursorAdvancedTo).toBeUndefined();
    expect(result.error).toBeTruthy();

    // 커서를 넘기는 마지막 "advance" 호출이 없어야 한다: 모든 upsertDaily 호출 중
    // lastChangeStatusCursor가 명시적으로 전달된 호출이 없어야 한다(날짜별 upsert는 커서 생략, 실패 시 advance 단계 스킵).
    const cursorCalls = upsertSpy.mock.calls.filter(([arg]: any) => arg.lastChangeStatusCursor !== undefined);
    expect(cursorCalls).toHaveLength(0);
  });

  it('커서를 넘기지 않은 upsert 호출은 실제 레포 계층에서 기존 커서를 보존한다 (M2, 레포 위임 검증)', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_method: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: '1' }] } };
      }
      if (path.includes('/query')) {
        return {
          data: [
            {
              order: { paymentDate: '2026-07-01T01:00:00.000Z' },
              productOrder: { productOrderId: '1', productOrderStatus: 'PAYED' },
            },
          ],
        };
      }
      return { data: {} };
    });

    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);

    const upsertSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily')
      .mockResolvedValue({} as any);

    await runChangedSync();

    // 날짜별 upsert 호출(2026-07-01)에는 lastChangeStatusCursor 키 자체가 없어야
    // 레포의 "undefined면 필드 생략" 로직으로 기존 커서가 보존된다.
    const dailyCall = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === '2026-07-01');
    expect(dailyCall).toBeTruthy();
    expect(dailyCall![0]).not.toHaveProperty('lastChangeStatusCursor');
  });
});

describe('syncOrdersByIds (발주확인 즉시 반영 — 변경피드 우회)', () => {
  beforeEach(() => {
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverDailyCache = {};
  });

  it('확인한 주문ID의 상세를 query로 직접 조회해 placeOrderStatus를 스냅샷(L1+DB)에 반영한다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    // 최근(2일 전) 주문 — 30일 조회범위 내이면서 미래가 아님(실행 시각과 무관하게 안전)
    const paymentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dateKey = orderToDateKey({ paymentDate })!;

    // 기존 스냅샷: 발주확인전(NOT_YET) 상태로 L1 캐시에 이미 존재
    (global as any).__naverDailyCache[dateKey] = {
      lastCallTime: Date.now() - 60_000,
      orders: [{ productOrderId: '1', productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET', paymentDate }],
      newOrdersCount: 1,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
    };

    // query API는 "발주확인 후" 현재 상태(placeOrderStatus=OK)를 반환한다.
    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('/query')) {
        return { data: [{ order: { paymentDate }, productOrder: { productOrderId: '1', productOrderStatus: 'PAYED', placeOrderStatus: 'OK' } }] };
      }
      return { data: {} };
    });
    const upsertSpy = vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockResolvedValue({} as any);

    const result = await syncOrdersByIds(['1']);

    expect(result.affectedDates).toContain(dateKey);

    // L1 캐시가 OK로 갱신되어야 대시보드 집계가 발주확인전→후로 이동한다.
    const cachedOrder = (global as any).__naverDailyCache[dateKey].orders.find((o: any) => o.productOrderId === '1');
    expect(cachedOrder.placeOrderStatus).toBe('OK');

    // DB upsert도 OK 상태의 merge 결과로 호출된다(콜드/타 인스턴스 하이드레이션 대비).
    const call = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === dateKey);
    expect(call).toBeTruthy();
    expect((call![0].orders.find((o: any) => o.productOrderId === '1') as any).placeOrderStatus).toBe('OK');
  });

  it('빈 ID 배열이면 API/DB 호출 없이 즉시 반환한다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const apiSpy = vi.spyOn(clientModule, 'apiRequest').mockResolvedValue({ data: [] });
    const res = await syncOrdersByIds([]);
    expect(res).toEqual({ updated: 0, affectedDates: [] });
    expect(apiSpy).not.toHaveBeenCalled();
  });
});

describe('runFullSync DB 기록 완료 대기 (2026-07-07 스냅샷 판독 레이스 회귀)', () => {
  beforeEach(() => {
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverDailyCache = {};
  });

  const makeContents = (productOrderId: string, paymentDate: string) => ({
    data: {
      contents: [
        {
          content: {
            order: { paymentDate },
            productOrder: { productOrderId, productOrderStatus: 'PAYED', paymentDate },
          },
        },
      ],
    },
  });

  it('runFullSync가 resolve될 때 모든 날짜의 upsertDaily가 이미 완료되어 있다 (fire-and-forget 금지)', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    const paymentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dateKey = orderToDateKey({ paymentDate })!;

    vi.spyOn(clientModule, 'apiRequest').mockResolvedValue(makeContents('1', paymentDate));

    // upsert를 인위적으로 지연시켜, fire-and-forget이면 runFullSync가 먼저 resolve되게 만든다.
    let upsertCompleted = false;
    const upsertSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily')
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 30));
        upsertCompleted = true;
        return {} as any;
      });

    const result = await runFullSync({ startDateKey: dateKey, endDateKey: dateKey, forceRefresh: true });

    // 핵심 검증: sync 완료 직후 findOne을 읽어도 최신 스냅샷이어야 하므로,
    // resolve 시점에 DB 기록이 반드시 끝나 있어야 한다.
    expect(upsertSpy).toHaveBeenCalled();
    expect(upsertCompleted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.affectedDates).toContain(dateKey);
  });

  it('개별 날짜의 upsert 실패는 warn만 남기고 전체 sync를 실패시키지 않는다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const day1Payment = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const day2Payment = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const day1Key = orderToDateKey({ paymentDate: day1Payment })!;
    const day2Key = orderToDateKey({ paymentDate: day2Payment })!;

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, _path: string, _body: any, params: any) => {
      const fromDateKey = toDateKeyKst(new Date(params.from));
      return fromDateKey === day1Key ? makeContents('1', day1Payment) : makeContents('2', day2Payment);
    });

    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockImplementation(async (input: any) => {
      if (input.snapshotDate === day1Key) {
        throw new Error(`DB write failed for ${day1Key}`);
      }
      return {} as any;
    });

    const result = await runFullSync({ startDateKey: day1Key, endDateKey: day2Key, forceRefresh: true });

    // 한 날짜의 persist 실패가 다른 날짜 처리나 전체 결과를 죽이지 않는다.
    expect(result.error).toBeUndefined();
    expect(result.affectedDates).toEqual(expect.arrayContaining([day1Key, day2Key]));
  });
});

describe('콜드 인스턴스 lost-update 방지 (2026-07-06 스냅샷 유실 실사고 회귀)', () => {
  beforeEach(() => {
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {}; // 콜드 인스턴스: L1 완전 비어있음
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  const paymentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const dateKey = orderToDateKey({ paymentDate })!;
  const dbSnapshotRow = {
    snapshotDate: dateKey,
    orders: [
      { productOrderId: 'EXIST-1', productOrderStatus: 'PAYED', placeOrderStatus: 'OK', paymentDate },
      { productOrderId: 'EXIST-2', productOrderStatus: 'PAYED', placeOrderStatus: 'OK', paymentDate },
    ],
    ordersCount: 2, newOrdersCount: 2, preparingCount: 0, deliveringCount: 0,
    isDirty: false, lastCallTime: new Date(), lastChangeStatusCursor: null,
  } as any;

  it('syncOrdersByIds: L1이 비어도 DB 스냅샷과 union으로 merge해 기존 주문을 보존한다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('/query')) {
        return { data: [{ order: { paymentDate }, productOrder: { productOrderId: 'NEW-1', productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET' } }] };
      }
      return { data: {} };
    });
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(dbSnapshotRow);
    const upsertSpy = vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockResolvedValue({} as any);

    await syncOrdersByIds(['NEW-1']);

    const call = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === dateKey);
    expect(call).toBeTruthy();
    const ids = (call![0].orders as any[]).map((o: any) => o.productOrderId).sort();
    expect(ids).toEqual(['EXIST-1', 'EXIST-2', 'NEW-1']); // 기존 2건 보존 + 신규 1건
  });

  it('runChangedSync: L1이 비어도 변경분만으로 DB를 덮지 않는다 (union merge)', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: 'NEW-1' }] } };
      }
      if (path.includes('/query')) {
        return { data: [{ order: { paymentDate }, productOrder: { productOrderId: 'NEW-1', productOrderStatus: 'PAYED' } }] };
      }
      return { data: {} };
    });
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(dbSnapshotRow);
    const upsertSpy = vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockResolvedValue({} as any);

    await runChangedSync();

    const call = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === dateKey);
    expect(call).toBeTruthy();
    const ids = (call![0].orders as any[]).map((o: any) => o.productOrderId).sort();
    expect(ids).toEqual(['EXIST-1', 'EXIST-2', 'NEW-1']); // lost-update 없음
  });

  it('runChangedSync 빈 피드 경로: L1 부분집합이 DB 스냅샷을 덮지 않는다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    // 오늘 날짜 기준 L1에 부분집합(1건)만 있는 워밍 인스턴스
    const todayKey = toDateKeyKst(new Date());
    const todayPayment = new Date().toISOString();
    (global as any).__naverDailyCache[todayKey] = {
      lastCallTime: Date.now() - 60_000,
      orders: [{ productOrderId: 'L1-ONLY', productOrderStatus: 'PAYED', paymentDate: todayPayment }],
      newOrdersCount: 1, preparingCount: 0, deliveringCount: 0, isDirty: false,
    };
    const todayDbRow = {
      ...dbSnapshotRow,
      snapshotDate: todayKey,
      orders: [
        { productOrderId: 'DB-1', productOrderStatus: 'PAYED', placeOrderStatus: 'OK', paymentDate: todayPayment },
        { productOrderId: 'DB-2', productOrderStatus: 'PAYED', placeOrderStatus: 'OK', paymentDate: todayPayment },
      ],
    };

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('last-changed-statuses')) return { data: { lastChangeStatuses: [] } }; // 변경 없음
      return { data: {} };
    });
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(todayDbRow);
    const upsertSpy = vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockResolvedValue({} as any);

    await runChangedSync();

    const call = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === todayKey);
    expect(call).toBeTruthy();
    const ids = (call![0].orders as any[]).map((o: any) => o.productOrderId).sort();
    expect(ids).toEqual(['DB-1', 'DB-2', 'L1-ONLY']); // DB 2건 보존 + L1 1건 union
  });
});

describe('runChangedSync 커서 전진 — 좁은 advanceCursor 경로 (egress 절감, 2026-07-24)', () => {
  useFixedClockForFixedDateFixtures(); // 픽스처가 2026-07-01 고정 — 보존 창 밖으로 밀리지 않게

  beforeEach(() => {
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
  });

  it('전체 성공 시 커서는 advanceCursor로만 전진하고, upsertDaily에는 커서가 실리지 않는다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: '1' }] } };
      }
      if (path.includes('/query')) {
        return {
          data: [
            {
              order: { paymentDate: '2026-07-01T01:00:00.000Z' },
              productOrder: { productOrderId: '1', productOrderStatus: 'PAYED' },
            },
          ],
        };
      }
      return { data: {} };
    });

    // 커서 보유 최신 스냅샷이 존재하는 정상 상태 — 좁은 select 이후의 반환 모양 그대로.
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue({
      snapshotDate: '2026-07-01',
      lastChangeStatusCursor: '2026-06-30T00:00:00.000Z',
    } as any);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(null);
    const upsertSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily')
      .mockResolvedValue({} as any);
    const advanceSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'advanceCursor')
      .mockResolvedValue({} as any);

    const result = await runChangedSync();

    expect(result.cursorAdvancedTo).toBeTruthy();
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(advanceSpy.mock.calls[0][0]).toBe('2026-07-01');
    // 커서 전진이 orders 재기록(upsertDaily) 경로로 새지 않는다 — 블롭 왕복 회귀 방지.
    const cursorCalls = upsertSpy.mock.calls.filter(([arg]: any) => arg.lastChangeStatusCursor !== undefined);
    expect(cursorCalls).toHaveLength(0);
  });

  it('부분 실패 시 advanceCursor도 호출되지 않는다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: '1' }] } };
      }
      if (path.includes('/query')) {
        return {
          data: [
            {
              order: { paymentDate: '2026-07-01T01:00:00.000Z' },
              productOrder: { productOrderId: '1', productOrderStatus: 'PAYED' },
            },
          ],
        };
      }
      return { data: {} };
    });

    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue({
      snapshotDate: '2026-07-01',
      lastChangeStatusCursor: '2026-06-30T00:00:00.000Z',
    } as any);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(null);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockRejectedValue(
      new Error('DB write failed'),
    );
    const advanceSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'advanceCursor')
      .mockResolvedValue({} as any);

    const result = await runChangedSync();

    expect(result.cursorAdvancedTo).toBeUndefined();
    expect(advanceSpy).not.toHaveBeenCalled();
  });
});
