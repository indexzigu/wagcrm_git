import { describe, expect, it } from 'vitest';
import {
  decidePostCloseCheck,
  isPostCloseTerminalOrder,
  postCloseCandidateEndDateFloor,
  POST_CLOSE_DAYS_AFTER_ALL_TERMINAL,
  POST_CLOSE_MAX_DAYS_AFTER_SALE_END,
} from '../post-close-check-window';

const DAY = 24 * 60 * 60 * 1000;
// 시각은 전부 명시 주입한다(시스템 시계 비의존).
const SALE_END = Date.UTC(2026, 8, 1, 14, 59, 59); // KST 09.01 23:59:59

function decide(overrides: Partial<Parameters<typeof decidePostCloseCheck>[0]>, nowMs: number) {
  return decidePostCloseCheck(
    { saleEndMs: SALE_END, allTerminalAtMs: null, locked: false, finalized: false, includeLocked: false, ...overrides },
    nowMs,
  );
}

describe('오너 기준 상수', () => {
  it('종결 +10일 · 판매 종료 +15일(오너 확정 2026-09-11)', () => {
    expect(POST_CLOSE_DAYS_AFTER_ALL_TERMINAL).toBe(10);
    expect(POST_CLOSE_MAX_DAYS_AFTER_SALE_END).toBe(15);
  });
});

describe('decidePostCloseCheck', () => {
  it('판매 종료 +15일까지는 조회하고, 넘으면 안전선에서 멈춘다', () => {
    expect(decide({}, SALE_END + 15 * DAY)).toBe('check');
    expect(decide({}, SALE_END + 15 * DAY + 1)).toBe('stop-backstop');
  });

  it('판매 종료일을 모르면 멈춘다(안전선을 세울 수 없다)', () => {
    expect(decide({ saleEndMs: null }, SALE_END)).toBe('stop-backstop');
  });

  it('전 주문 종결을 처음 본 날 +10일이 되면 멈춘다', () => {
    const terminalAt = SALE_END + 2 * DAY;
    expect(decide({ allTerminalAtMs: terminalAt }, terminalAt + 10 * DAY - 1)).toBe('check');
    expect(decide({ allTerminalAtMs: terminalAt }, terminalAt + 10 * DAY)).toBe('stop-after-terminal');
  });

  it('정산 락 + 확정 마커면 기존 규칙대로 건너뛴다', () => {
    expect(decide({ locked: true, finalized: true }, SALE_END + DAY)).toBe('skip-finalized');
  });

  it('락이지만 아직 확정 전이면 조회한다(락 이후 확정 계산 1회)', () => {
    expect(decide({ locked: true, finalized: false }, SALE_END + DAY)).toBe('check');
  });

  it('수동 레버(includeLocked)는 확정·종결 중단을 넘지만 안전선은 넘지 않는다', () => {
    const terminalAt = SALE_END + DAY;
    expect(
      decide({ locked: true, finalized: true, allTerminalAtMs: terminalAt, includeLocked: true }, terminalAt + 11 * DAY),
    ).toBe('check');
    expect(decide({ includeLocked: true }, SALE_END + 16 * DAY)).toBe('stop-backstop');
  });
});

describe('isPostCloseTerminalOrder', () => {
  const order = (productOrderStatus: string, claim?: Record<string, unknown>) => ({
    productOrderId: 'po-1',
    productOrderStatus,
    ...(claim ? { __claim: claim } : {}),
  });

  it.each(['PURCHASE_DECIDED', 'CANCELED', 'CANCELED_BY_NOPAYMENT', 'RETURNED', 'EXCHANGED'])('%s 는 종결', (status) => {
    expect(isPostCloseTerminalOrder(order(status))).toBe(true);
  });

  it.each(['PAYED', 'PRODUCT_READY', 'DISPATCHED', 'DELIVERING'])('%s 는 아직 움직인다', (status) => {
    expect(isPostCloseTerminalOrder(order(status))).toBe(false);
  });

  it('배송완료이고 클레임이 없으면 종결', () => {
    expect(isPostCloseTerminalOrder(order('DELIVERED'))).toBe(true);
  });

  it('배송완료라도 반품 요청이 진행 중이면 종결이 아니다', () => {
    expect(isPostCloseTerminalOrder(order('DELIVERED', { return: { claimStatus: 'RETURN_REQUEST' } }))).toBe(false);
  });

  it('배송완료 + 반품 완료 클레임이면 종결', () => {
    expect(isPostCloseTerminalOrder(order('DELIVERED', { return: { claimStatus: 'RETURN_DONE' } }))).toBe(true);
  });
});

describe('postCloseCandidateEndDateFloor', () => {
  it('안전선보다 하루 넉넉한 거친 하한이다', () => {
    const now = SALE_END + 20 * DAY;
    expect(postCloseCandidateEndDateFloor(now).getTime()).toBe(now - 16 * DAY);
  });
});
