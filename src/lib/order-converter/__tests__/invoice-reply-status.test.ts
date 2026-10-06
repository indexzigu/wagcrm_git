import { describe, expect, it } from 'vitest';
import {
  deriveReplySentDates,
  formatInvoiceReplyLine,
  resolveInvoiceReplyStatus,
} from '../invoice-reply-status';

/**
 * 송장 회신 도착 표시 — 「처리됨」을 저장하지 않고 **배송대기 상태에서 파생**한다는 계약.
 * 송장이 등록돼 주문이 배송대기를 벗어나면 같은 감지 행이 있어도 줄이 사라져야 한다.
 */

const T = (iso: string) => new Date(iso);

describe('resolveInvoiceReplyStatus', () => {
  const detection = (receivedAt: string, keys: string[] | null) => ({
    receivedAt: T(receivedAt),
    trackingOrderKeys: keys,
  });

  it('회신이 덮는 주문이 아직 배송대기면 미처리로 띄운다(건수 = 아직 배송대기인 키 수)', () => {
    const status = resolveInvoiceReplyStatus([detection('2026-10-06T05:10:00Z', ['po-1', 'po-2', 'po-3'])], {
      keys: new Set(['po-1', 'po-2', 'po-9']),
      oldestPoRequestedAtMs: T('2026-10-06T01:00:00Z').getTime(),
    });
    expect(status).toEqual({ count: 2, receivedAt: '2026-10-06T05:10:00.000Z' });
  });

  it('송장이 등록돼 회신의 주문이 전부 배송대기를 벗어나면 사라진다(행은 그대로)', () => {
    const rows = [detection('2026-10-06T05:10:00Z', ['po-1', 'po-2'])];
    // 등록 전
    expect(
      resolveInvoiceReplyStatus(rows, { keys: new Set(['po-1', 'po-2']), oldestPoRequestedAtMs: 0 }),
    ).not.toBeNull();
    // 등록 후 — 같은 회차의 다른 주문만 배송대기에 남았다
    expect(
      resolveInvoiceReplyStatus(rows, { keys: new Set(['po-7']), oldestPoRequestedAtMs: 0 }),
    ).toBeNull();
  });

  it('배송대기가 0건이면 회신이 있어도 띄우지 않는다', () => {
    expect(
      resolveInvoiceReplyStatus([detection('2026-10-06T05:10:00Z', null)], { keys: new Set(), oldestPoRequestedAtMs: null }),
    ).toBeNull();
  });

  it('회신 엑셀이 주문번호(상품주문번호 아님)를 써도 맞춘다 — 배송대기 키에 둘 다 들어 있다', () => {
    const status = resolveInvoiceReplyStatus([detection('2026-10-06T05:10:00Z', ['order-100'])], {
      keys: new Set(['po-1', 'order-100']),
      oldestPoRequestedAtMs: 0,
    });
    expect(status?.count).toBe(1);
  });

  it('주문번호를 못 읽은 회신은 가장 오래된 배송대기 발주요청 이후에 왔을 때만 띄운다', () => {
    const pending = { keys: new Set(['po-1']), oldestPoRequestedAtMs: T('2026-10-06T03:00:00Z').getTime() };
    expect(resolveInvoiceReplyStatus([detection('2026-10-06T02:00:00Z', null)], pending)).toBeNull();
    expect(resolveInvoiceReplyStatus([detection('2026-10-06T04:00:00Z', [])], pending)).toEqual({
      count: 0,
      receivedAt: '2026-10-06T04:00:00.000Z',
    });
  });

  it('여러 회신이면 가장 최근 수신 시각을, 건수는 중복 없이 합친다', () => {
    const status = resolveInvoiceReplyStatus(
      [detection('2026-10-06T02:00:00Z', ['po-1', 'po-2']), detection('2026-10-06T06:00:00Z', ['po-2', 'po-3'])],
      { keys: new Set(['po-1', 'po-2', 'po-3']), oldestPoRequestedAtMs: 0 },
    );
    expect(status).toEqual({ count: 3, receivedAt: '2026-10-06T06:00:00.000Z' });
  });
});

describe('formatInvoiceReplyLine', () => {
  const now = T('2026-10-06T08:00:00Z'); // KST 17:00

  it('오늘 회신이면 「송장 회신 도착 · 주문 N건 · HH:MM」(KST)', () => {
    expect(formatInvoiceReplyLine({ count: 12, receivedAt: '2026-10-06T05:05:00Z' }, now)).toBe('송장 회신 도착 · 주문 12건 · 14:05');
  });

  it('건수를 못 읽었으면 건수 칸을 뺀다(0건이라고 쓰지 않는다)', () => {
    expect(formatInvoiceReplyLine({ count: 0, receivedAt: '2026-10-06T05:05:00Z' }, now)).toBe('송장 회신 도착 · 14:05');
  });

  it('오늘이 아니면 날짜를 붙인다', () => {
    expect(formatInvoiceReplyLine({ count: 3, receivedAt: '2026-10-04T05:05:00Z' }, now)).toBe('송장 회신 도착 · 주문 3건 · 10.04 14:05');
  });
});

describe('deriveReplySentDates — 수동 버튼과 크론이 같은 규칙', () => {
  it('EMAILED·PENDING 작업 날짜를 YYMMDD 로', () => {
    expect(
      deriveReplySentDates([
        { date: '2026-10-06', status: 'EMAILED' },
        { date: '2026-10-05', status: 'COMPLETED' },
        { date: '2026-10-04', status: 'PENDING' },
      ]),
    ).toEqual(['261006', '261004']);
  });

  it('해당 작업이 없으면 오늘(KST)', () => {
    // UTC 로는 10-05 이지만 KST 로는 10-06 이다.
    expect(deriveReplySentDates([], T('2026-10-05T16:30:00Z'))).toEqual(['261006']);
    expect(deriveReplySentDates(undefined, T('2026-10-05T16:30:00Z'))).toEqual(['261006']);
  });
});
