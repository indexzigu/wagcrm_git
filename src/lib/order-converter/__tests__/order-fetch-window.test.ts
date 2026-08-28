import { describe, it, expect, vi } from 'vitest';
import {
  CURSOR_STALE_MS,
  NEW_ORDERS_COUNT_STATUSES,
  PENDING_FULFILLMENT_STATUSES,
  addKstDays,
  decideChunkSkip,
  fetchPendingOrderWindow,
  findChunkIntegrityIssues,
  isCursorHealthy,
  kstDayEndMs,
  kstDayStartMs,
  planKstDayChunks,
  toKstDateKey,
  type SnapshotCountRow,
} from '../order-fetch-window';
import { countStatuses } from '../naver-order-sync';

const kst = (iso: string) => Date.parse(iso);

describe('planKstDayChunks — KST 자정 정렬', () => {
  it('실사고 회귀: startDate(UTC 자정 = KST 09:00)에서 시작해도 청크가 KST 날짜에 정렬된다', () => {
    // 종전 구현은 여기서 23.9h 씩 전진해 "07-12" 라벨 청크가 07-12 09:00~07-13 08:54 를
    // 덮었다(24h 중 07-12 는 15h 분). 날짜 단위 판정이 다른 날짜 근거를 보게 되던 원인.
    const start = kst('2026-07-12T00:00:00.000Z'); // = KST 07-12 09:00
    const now = kst('2026-07-14T05:00:00.000Z'); // = KST 07-14 14:00
    const chunks = planKstDayChunks(start, now);

    expect(chunks.map((c) => c.dateKey)).toEqual(['2026-07-12', '2026-07-13', '2026-07-14']);
    // 첫 청크는 창 시작 시각부터(자정으로 되돌리지 않는다 — 창 밖 주문을 끌어오지 않기 위해)
    expect(chunks[0].fromIso).toBe(new Date(start).toISOString());
    // 첫 청크의 끝은 그 KST 날짜의 끝이다 — 다음 날로 새지 않는다.
    expect(Date.parse(chunks[0].toIso)).toBe(kstDayEndMs('2026-07-12'));
    // 중간 청크는 KST 자정~자정 끝
    expect(Date.parse(chunks[1].fromIso)).toBe(kstDayStartMs('2026-07-13'));
    expect(Date.parse(chunks[1].toIso)).toBe(kstDayEndMs('2026-07-13'));
    // 마지막 청크는 now 로 잘린다(미래 조회 금지)
    expect(Date.parse(chunks[2].toIso)).toBe(now);
  });

  it('같은 날 안이면 청크 1개', () => {
    const start = kst('2026-07-30T01:00:00.000Z');
    const now = kst('2026-07-30T04:00:00.000Z');
    const chunks = planKstDayChunks(start, now);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].dateKey).toBe('2026-07-30');
  });

  it('baseline 재현: 07-12 ~ 07-30 이면 19청크', () => {
    // 실측 baseline 의 logicalCalls=19 와 일치해야 한다(전량 조회 시).
    const chunks = planKstDayChunks(kst('2026-07-12T00:00:00.000Z'), kst('2026-07-30T04:39:00.000Z'));
    expect(chunks).toHaveLength(19);
  });

  it('start > now 이거나 값이 이상하면 빈 배열(호출부가 무한 루프 돌지 않게)', () => {
    expect(planKstDayChunks(kst('2026-07-30T00:00:00Z'), kst('2026-07-01T00:00:00Z'))).toEqual([]);
    expect(planKstDayChunks(NaN, Date.now())).toEqual([]);
  });

  it('KST 날짜 헬퍼 — 서버 TZ 무관', () => {
    expect(toKstDateKey(kst('2026-07-12T15:00:00.000Z'))).toBe('2026-07-13'); // KST 자정
    expect(toKstDateKey(kst('2026-07-12T14:59:59.999Z'))).toBe('2026-07-12');
    expect(addKstDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addKstDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('decideChunkSkip — 증거 기반 생략', () => {
  const snap = (over: Partial<SnapshotCountRow> = {}): SnapshotCountRow => ({
    snapshotDate: '2026-07-15',
    ordersCount: 10,
    newOrdersCount: 0,
    lastCallTime: new Date('2026-07-30T02:00:00Z'),
    ...over,
  });

  const base = { dateKey: '2026-07-15', todayKey: '2026-07-30', cursorHealthy: true };

  it('스냅샷이 발주 대상 0을 증언하면 생략', () => {
    expect(decideChunkSkip({ ...base, snapshot: snap() })).toEqual({
      skip: true,
      reason: 'snapshot-says-no-pending',
    });
  });

  it('발주 대상이 남아 있으면 조회', () => {
    expect(decideChunkSkip({ ...base, snapshot: snap({ newOrdersCount: 3 }) })).toEqual({
      skip: false,
      reason: 'snapshot-has-pending',
    });
  });

  it('스냅샷 행이 없으면 조회 — "모름"을 "없음"으로 읽지 않는다(fail-safe)', () => {
    // 공백일(그 날 주문 0)일 수도, 동기화가 안 닿은 날일 수도 있어 구분이 안 된다.
    expect(decideChunkSkip({ ...base, snapshot: undefined })).toEqual({
      skip: false,
      reason: 'no-snapshot-row',
    });
  });

  it('오늘·어제는 스냅샷이 0이라 해도 항상 조회', () => {
    expect(decideChunkSkip({ ...base, dateKey: '2026-07-30', snapshot: snap() }).skip).toBe(false);
    expect(decideChunkSkip({ ...base, dateKey: '2026-07-29', snapshot: snap() })).toEqual({
      skip: false,
      reason: 'recent-day',
    });
    // 그저께는 생략 대상
    expect(decideChunkSkip({ ...base, dateKey: '2026-07-28', snapshot: snap() }).skip).toBe(true);
  });

  it('커서가 멈췄으면 전량 조회 — 스냅샷이 신규 결제를 못 받았을 수 있다', () => {
    expect(decideChunkSkip({ ...base, snapshot: snap(), cursorHealthy: false })).toEqual({
      skip: false,
      reason: 'cursor-stale',
    });
  });

  it('월 경계에서도 어제 판정이 맞다', () => {
    expect(decideChunkSkip({ ...base, dateKey: '2026-07-31', todayKey: '2026-08-01', snapshot: snap() })).toEqual({
      skip: false,
      reason: 'recent-day',
    });
  });
});

describe('생략 게이트의 전제 계약 — 근거가 대상의 상위집합이어야 한다', () => {
  // 이 테스트가 이 설계의 안전 근거다. 게이트는 newOrdersCount 로 "발주 대상 0"을 판정하는데,
  // 발주 대상 상태 목록이 그 카운터의 커버 범위를 벗어나면 **그 상태만 남은 날짜를 조용히
  // 생략**해 발주서에서 누락시킨다(P0 — 발주서 누락 = 배송 누락).
  it('PENDING_FULFILLMENT_STATUSES ⊆ NEW_ORDERS_COUNT_STATUSES', () => {
    const covered = new Set<string>(NEW_ORDERS_COUNT_STATUSES);
    const uncovered = PENDING_FULFILLMENT_STATUSES.filter((s) => !covered.has(s));
    expect(uncovered).toEqual([]);
  });

  it('countStatuses 가 실제로 그 상태 전부를 newOrdersCount 로 센다(구현 대조)', () => {
    for (const status of PENDING_FULFILLMENT_STATUSES) {
      const { newOrdersCount } = countStatuses([{ productOrderStatus: status }]);
      expect(newOrdersCount, `${status} 가 newOrdersCount 에 안 잡힌다`).toBe(1);
    }
  });
});

describe('isCursorHealthy', () => {
  const now = kst('2026-07-30T04:00:00.000Z');
  it('상한 이내면 건강', () => {
    expect(isCursorHealthy('2026-07-30T03:00:00.000Z', now)).toBe(true);
    expect(isCursorHealthy(new Date(now - CURSOR_STALE_MS + 1000).toISOString(), now)).toBe(true);
  });
  it('상한 초과·없음·파싱 불가는 불건강 → 생략 안 함', () => {
    expect(isCursorHealthy(new Date(now - CURSOR_STALE_MS - 1000).toISOString(), now)).toBe(false);
    expect(isCursorHealthy(null, now)).toBe(false);
    expect(isCursorHealthy('아무말', now)).toBe(false);
  });
});

describe('findChunkIntegrityIssues — 스냅샷을 oracle 로 쓴 조회 온전성 대조', () => {
  const rows: SnapshotCountRow[] = [
    { snapshotDate: '2026-07-13', ordersCount: 52, newOrdersCount: 0, lastCallTime: new Date() },
    { snapshotDate: '2026-07-14', ordersCount: 10, newOrdersCount: 0, lastCallTime: new Date() },
  ];

  it('스냅샷보다 적게 조회되면 under-fetch 로 표면화(절단·부분 실패 신호)', () => {
    const issues = findChunkIntegrityIssues({ '2026-07-13': 40 }, rows);
    expect(issues).toEqual([{ dateKey: '2026-07-13', fetched: 40, snapshot: 52, kind: 'under-fetch' }]);
  });

  it('같거나 많으면 정상 — 스냅샷 이후 신규 주문이 붙을 수 있다', () => {
    expect(findChunkIntegrityIssues({ '2026-07-13': 52, '2026-07-14': 12 }, rows)).toEqual([]);
  });

  it('스냅샷 행이 없는 날짜는 대조하지 않는다(비교 대상 없음)', () => {
    expect(findChunkIntegrityIssues({ '2026-07-29': 3 }, rows)).toEqual([]);
  });
});

describe('fetchPendingOrderWindow — 오케스트레이션', () => {
  const nowMs = kst('2026-07-30T04:00:00.000Z'); // KST 07-30 13:00
  const startMs = kst('2026-07-26T00:00:00.000Z'); // KST 07-26 09:00 → 07-26..07-30 = 5청크

  const wrapper = (id: string) => ({
    content: { productOrder: { productOrderId: id, productOrderStatus: 'PAYED' }, order: { orderId: `o-${id}` } },
  });

  const freshCursor = () => new Date(nowMs - 60_000).toISOString();

  function deps(over: Partial<Parameters<typeof fetchPendingOrderWindow>[1]> = {}) {
    return {
      apiRequest: vi.fn(async () => ({ data: { contents: [wrapper('a')] } })),
      loadSnapshotCounts: vi.fn(async () => [] as SnapshotCountRow[]),
      loadLatestCursorIso: vi.fn(async () => freshCursor()),
      sleep: vi.fn(async () => {}),
      nowMs,
      ...over,
    };
  }

  it('스냅샷이 발주 대상 0을 증언한 과거 날짜는 조회하지 않는다 — 호출 수 감소의 실체', async () => {
    const snapshots: SnapshotCountRow[] = ['2026-07-26', '2026-07-27', '2026-07-28'].map((d) => ({
      snapshotDate: d,
      ordersCount: 5,
      newOrdersCount: 0,
      lastCallTime: new Date(nowMs),
    }));
    const d = deps({ loadSnapshotCounts: vi.fn(async () => snapshots) });

    const res = await fetchPendingOrderWindow(startMs, d);

    expect(res.chunks).toHaveLength(5);
    // 07-26·27·28 은 생략, 07-29(어제)·07-30(오늘)만 조회
    expect(res.skippedDateKeys).toEqual(['2026-07-26', '2026-07-27', '2026-07-28']);
    expect(d.apiRequest).toHaveBeenCalledTimes(2);
    expect(res.skipReasons['2026-07-29']).toBe('recent-day');
    expect(res.failure).toBeNull();
  });

  it('커서가 멈추면 아무 것도 생략하지 않는다(안전 강등)', async () => {
    const snapshots: SnapshotCountRow[] = ['2026-07-26', '2026-07-27'].map((dk) => ({
      snapshotDate: dk, ordersCount: 5, newOrdersCount: 0, lastCallTime: new Date(nowMs),
    }));
    const d = deps({
      loadSnapshotCounts: vi.fn(async () => snapshots),
      loadLatestCursorIso: vi.fn(async () => new Date(nowMs - CURSOR_STALE_MS - 1).toISOString()),
    });

    const res = await fetchPendingOrderWindow(startMs, d);

    expect(res.skippedDateKeys).toEqual([]);
    expect(d.apiRequest).toHaveBeenCalledTimes(5);
  });

  it('생략 근거 로드가 실패하면 전량 조회로 강등한다 — 못 읽은 것을 "없음"으로 읽지 않는다', async () => {
    const d = deps({
      loadSnapshotCounts: vi.fn(async () => {
        throw new Error('DB down');
      }),
    });

    const res = await fetchPendingOrderWindow(startMs, d);

    expect(res.skippedDateKeys).toEqual([]);
    expect(d.apiRequest).toHaveBeenCalledTimes(5);
  });

  it('청크 조회가 재시도 후에도 실패하면 중단하고 failure 를 채운다(누락 발주서 방지)', async () => {
    const d = deps({
      apiRequest: vi.fn(async () => {
        throw new Error('네이버 장애');
      }),
    });

    const res = await fetchPendingOrderWindow(startMs, d);

    expect(res.failure).toEqual({ dateKey: '2026-07-26', message: '네이버 장애' });
    // 첫 청크에서 2회 시도 후 중단 — 뒤 청크로 넘어가지 않는다.
    expect(d.apiRequest).toHaveBeenCalledTimes(2);
    expect(res.items).toEqual([]);
  });

  it('조회하는 청크는 page 를 따라가 전 페이지를 모은다(절단 방어의 실체)', async () => {
    // 종전에는 page 를 안 보내 창당 300건 초과분이 조용히 유실됐다. 계약 확정 후
    // product-order-paging 이 page 를 따라간다 — 그 배선이 살아있는지 여기서 고정한다.
    const calls: Array<{ page: string; from: string }> = [];
    const d = deps({
      loadSnapshotCounts: vi.fn(async () => []),
      apiRequest: vi.fn(async (_m: string, _p: string, _b: unknown, q: any) => {
        calls.push({ page: q.page, from: q.from });
        // 1페이지는 꽉 차고(300) 2페이지에서 끝난다.
        const full = Array.from({ length: 300 }, (_, i) => wrapper(`p1-${i}`));
        return { data: { contents: q.page === '1' ? full : [wrapper('p2-0')] } };
      }),
    });

    const res = await fetchPendingOrderWindow(kst('2026-07-29T15:00:00.000Z'), d);

    // 하루 창 1개인데 2페이지를 따라갔다.
    expect(calls.map((c) => c.page)).toEqual(['1', '2']);
    expect(res.items).toHaveLength(301);
    expect(res.failure).toBeNull();
  });

  it('조회 창을 PAYED_DATETIME 으로 명시한다 — 생략 게이트의 전제(창 술어 == 스냅샷 귀속)', async () => {
    // 스냅샷은 paymentDate 우선으로 날짜를 귀속하는데(orderToDateKey), 조회 창의 술어를
    // API 기본값에 맡기면 그 일치가 운에 달린다. 날짜별 생략 판정이 이 일치를 전제로
    // 성립하므로 명시가 필요하다(오너 결정 2026-07-30, 1단계 = 발주서 경로만).
    const d = deps({ loadSnapshotCounts: vi.fn(async () => []) });

    await fetchPendingOrderWindow(kst('2026-07-29T15:00:00.000Z'), d);

    // deps() 반환형이 인터페이스라 vi.Mock 프로퍼티가 안 보인다 — 목으로 좁혀 읽는다.
    const apiRequestMock = vi.mocked(d.apiRequest);
    expect(apiRequestMock).toHaveBeenCalled();
    for (const call of apiRequestMock.mock.calls) {
      expect(call[3]).toMatchObject({ rangeType: 'PAYED_DATETIME' });
    }
  });

  it('생략한 청크엔 레이트리밋 대기를 붙이지 않는다 — 지연 절감의 실체', async () => {
    const snapshots: SnapshotCountRow[] = ['2026-07-26', '2026-07-27', '2026-07-28'].map((dk) => ({
      snapshotDate: dk, ordersCount: 5, newOrdersCount: 0, lastCallTime: new Date(nowMs),
    }));
    const d = deps({ loadSnapshotCounts: vi.fn(async () => snapshots) });

    await fetchPendingOrderWindow(startMs, d);

    // 조회한 청크 2개 중 마지막 뒤에는 대기를 안 붙이므로 sleep 은 1회뿐이다.
    expect(d.sleep).toHaveBeenCalledTimes(1);
  });

  it('계측 훅이 논리 호출·생략을 각각 보고한다(요약 행의 카운터 근거)', async () => {
    const snapshots: SnapshotCountRow[] = [
      { snapshotDate: '2026-07-26', ordersCount: 5, newOrdersCount: 0, lastCallTime: new Date(nowMs) },
    ];
    const onLogicalCall = vi.fn();
    const onSkipped = vi.fn();
    const d = deps({ loadSnapshotCounts: vi.fn(async () => snapshots), onLogicalCall, onSkipped });

    await fetchPendingOrderWindow(startMs, d);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onLogicalCall).toHaveBeenCalledTimes(4);
  });

  it('조회 결과가 스냅샷보다 적으면 integrityIssues 로 표면화한다', async () => {
    const snapshots: SnapshotCountRow[] = [
      { snapshotDate: '2026-07-30', ordersCount: 99, newOrdersCount: 1, lastCallTime: new Date(nowMs) },
    ];
    const d = deps({ loadSnapshotCounts: vi.fn(async () => snapshots) });

    const res = await fetchPendingOrderWindow(kst('2026-07-29T15:00:00.000Z'), d);

    expect(res.integrityIssues).toEqual([
      { dateKey: '2026-07-30', fetched: 1, snapshot: 99, kind: 'under-fetch' },
    ]);
  });
});
