import { describe, expect, it } from 'vitest';
import {
  collectPreparedOrderWrappers,
  decidePreparedPoAvailability,
  describePreparedPoUnavailable,
  earliestMaintainedDateKey,
  preparedSnapshotRange,
} from '../prepared-po';
import { toKstDateKey } from '../order-fetch-window';

/**
 * 준비본 가용성 판정 — 카드 줄·발주요청 창·서버 미리보기가 같은 판정을 쓴다.
 * 시각은 전부 고정 nowMs 기준의 상대값이라 날짜가 바뀌어도 깨지지 않는다(P9 시한폭탄 규칙).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const nowMs = Date.parse('2026-10-06T06:00:00.000Z'); // KST 15:00

function decide(over: Partial<Parameters<typeof decidePreparedPoAvailability>[0]> = {}) {
  return decidePreparedPoAvailability({
    autoPrepEnabled: true,
    cursorIso: new Date(nowMs - HOUR).toISOString(),
    queryStartMs: nowMs - 5 * DAY,
    nowMs,
    ...over,
  });
}

describe('decidePreparedPoAvailability', () => {
  it('켜져 있고 1시간 전 동기화 · 5일 창이면 준비본을 쓸 수 있고 기준 시각은 커서다', () => {
    expect(decide()).toEqual({ available: true, asOfIso: new Date(nowMs - HOUR).toISOString() });
  });

  it('꺼져 있으면 동기화가 신선해도 「꺼짐」이 먼저다', () => {
    expect(decide({ autoPrepEnabled: false })).toMatchObject({ available: false, reason: 'disabled' });
  });

  it('동기화 기록이 없거나 읽을 수 없는 값이면 「기록 없음」', () => {
    expect(decide({ cursorIso: null })).toMatchObject({ available: false, reason: 'no-sync', asOfIso: null });
    expect(decide({ cursorIso: 'not-a-date' })).toMatchObject({ available: false, reason: 'no-sync' });
  });

  it('6시간 경계 — 6시간 정각은 허용, 그보다 1분 낡으면 막는다(발주 조회 생략 게이트와 같은 문턱)', () => {
    expect(decide({ cursorIso: new Date(nowMs - 6 * HOUR).toISOString() }).available).toBe(true);
    expect(decide({ cursorIso: new Date(nowMs - 6 * HOUR - 60_000).toISOString() })).toMatchObject({
      available: false,
      reason: 'stale-sync',
    });
  });

  it('조회창 시작일이 동기화가 고쳐 쓰는 범위(최근 30일) 밖이면 막는다', () => {
    const floorKey = earliestMaintainedDateKey(nowMs);
    const floorStartMs = Date.parse(`${floorKey}T00:00:00.000+09:00`);
    expect(decide({ queryStartMs: floorStartMs }).available).toBe(true);
    expect(decide({ queryStartMs: floorStartMs - 1 })).toMatchObject({ available: false, reason: 'window-too-old' });
  });

  it('막힌 사유는 사람 말로 설명된다', () => {
    expect(describePreparedPoUnavailable('disabled', null)).toContain('꺼져 있습니다');
    expect(describePreparedPoUnavailable('stale-sync', '2026-10-06T00:00:00.000Z')).toContain('10/06 09:00 기준');
    expect(describePreparedPoUnavailable('window-too-old', null)).toContain('30일');
  });
});

describe('preparedSnapshotRange · collectPreparedOrderWrappers', () => {
  it('범위는 조회창 시작일 ~ 오늘(KST)', () => {
    expect(preparedSnapshotRange(nowMs - 3 * DAY, nowMs)).toEqual({
      startKey: toKstDateKey(nowMs - 3 * DAY),
      endKey: toKstDateKey(nowMs),
    });
  });

  it('범위 밖 날짜는 버리고, 같은 상품주문이 두 날짜에 있으면 더 최근에 쓰인 쪽을 한 번만 싣는다', () => {
    const l1 = {
      '2026-10-01': { lastCallTime: 100, orders: [{ productOrderId: 'A', placeOrderStatus: 'NOT_YET' }] },
      '2026-10-02': { lastCallTime: 200, orders: [{ productOrderId: 'A', placeOrderStatus: 'OK' }, { productOrderId: 'B' }] },
      '2026-09-01': { lastCallTime: 300, orders: [{ productOrderId: 'OLD' }] },
    };
    const wrappers = collectPreparedOrderWrappers(l1, '2026-10-01', '2026-10-06');
    const ids = wrappers.map((w) => w.productOrder.productOrderId).sort();
    expect(ids).toEqual(['A', 'B']);
    expect(wrappers.find((w) => w.productOrder.productOrderId === 'A')!.productOrder.placeOrderStatus).toBe('OK');
    // 조회 응답 모양 — 같은 평평한 객체를 order·productOrder 양쪽에 꽂는다.
    expect(wrappers[0].order).toBe(wrappers[0].productOrder);
  });
});
