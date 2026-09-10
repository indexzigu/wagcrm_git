import { describe, expect, it } from 'vitest';
import {
  decidePostCloseCheck,
  isPostCloseTerminalOrder,
  nextAllTerminalMarker,
  postCloseCandidateEndDateFloor,
  POST_CLOSE_DAYS_AFTER_ALL_TERMINAL,
  POST_CLOSE_MAX_DAYS_WITHOUT_TERMINAL,
} from '../post-close-check-window';

const DAY = 24 * 60 * 60 * 1000;
/** KST 벽시계 → epoch ms. 시각은 전부 명시 주입한다(시스템 시계 비의존). */
const kst = (month: number, day: number, hour: number, minute = 0, second = 0) =>
  Date.UTC(2026, month - 1, day, hour - 9, minute, second);
const SALE_END = kst(9, 1, 23, 59, 59); // 판매 종료 = KST 09.01 종일

function decide(overrides: Partial<Parameters<typeof decidePostCloseCheck>[0]>, nowMs: number) {
  return decidePostCloseCheck(
    { saleEndMs: SALE_END, allTerminalAtMs: null, locked: false, finalized: false, includeLocked: false, ...overrides },
    nowMs,
  );
}

describe('기준 상수', () => {
  it('종결 +10일(오너 확정 2026-09-11) · 종결 미관측 상한 판매 종료 +15일(오너 승인 계획)', () => {
    expect(POST_CLOSE_DAYS_AFTER_ALL_TERMINAL).toBe(10);
    expect(POST_CLOSE_MAX_DAYS_WITHOUT_TERMINAL).toBe(15);
  });
});

describe('decidePostCloseCheck', () => {
  it('종결을 못 본 캠페인은 판매 종료 +15일(KST 날짜)까지 조회하고, 그다음 날 멈춘다', () => {
    expect(decide({}, kst(9, 16, 6, 30))).toBe('check');
    expect(decide({}, kst(9, 16, 23, 59))).toBe('check');
    expect(decide({}, kst(9, 17, 6, 30))).toBe('stop-backstop');
  });

  it('판매 종료일을 모르면 멈춘다(상한을 세울 수 없다)', () => {
    expect(decide({ saleEndMs: null }, SALE_END)).toBe('stop-backstop');
  });

  it('전 주문 종결을 처음 본 날 +10일(KST 날짜)이 되면 멈춘다', () => {
    const terminalAt = kst(9, 3, 6, 35);
    expect(decide({ allTerminalAtMs: terminalAt }, kst(9, 12, 23, 59))).toBe('check');
    expect(decide({ allTerminalAtMs: terminalAt }, kst(9, 13, 6, 35))).toBe('stop-after-terminal');
  });

  it('+10일째 실행이 찍힌 시각보다 이른 시각에 와도 그날 멈춘다(크론 도달 시각 흔들림)', () => {
    // 🪤 밀리초로 비교하면 06:20 < 06:35 라 하루 더 조회한다 — 이 판정은 정산 크론 끝자락에서 돈다.
    const terminalAt = kst(9, 3, 6, 35);
    expect(decide({ allTerminalAtMs: terminalAt }, kst(9, 13, 6, 20))).toBe('stop-after-terminal');
  });

  it('늦게 배송돼 종결을 판매 종료 +8일에 봤으면 +15일을 넘어도 종결 +10일까지 조회한다', () => {
    // 공구는 판매 종료 뒤 배송이 흔하다 — 판매 종료 기준으로 자르면 오너 기준(배송완료 +10일)이 잘린다.
    const terminalAt = kst(9, 9, 6, 30);
    expect(decide({ allTerminalAtMs: terminalAt }, kst(9, 18, 6, 30))).toBe('check');
    expect(decide({ allTerminalAtMs: terminalAt }, kst(9, 19, 6, 30))).toBe('stop-after-terminal');
  });

  it('정산 락 + 확정 마커면 기존 규칙대로 건너뛴다', () => {
    expect(decide({ locked: true, finalized: true }, kst(9, 2, 6, 30))).toBe('skip-finalized');
  });

  it('락이지만 아직 확정 전이면 조회한다(락 이후 확정 계산 1회)', () => {
    expect(decide({ locked: true, finalized: false }, kst(9, 2, 6, 30))).toBe('check');
  });

  it('수동 레버(includeLocked)는 확정·종결 중단을 넘지만 종결 미관측 상한은 넘지 않는다', () => {
    const terminalAt = kst(9, 2, 6, 30);
    expect(
      decide({ locked: true, finalized: true, allTerminalAtMs: terminalAt, includeLocked: true }, kst(9, 13, 6, 30)),
    ).toBe('check');
    expect(decide({ includeLocked: true }, kst(9, 17, 6, 30))).toBe('stop-backstop');
  });
});

describe('isPostCloseTerminalOrder', () => {
  const order = (productOrderStatus: string, extra: Record<string, unknown> = {}) => ({
    productOrderId: 'po-1',
    productOrderStatus,
    ...extra,
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

  it.each(['RETURN_DONE', 'EXCHANGE_DONE', 'RETURN_REJECT', 'EXCHANGE_REJECT'])(
    '배송완료 + 끝난 클레임(%s)이면 종결',
    (claimStatus) => {
      expect(isPostCloseTerminalOrder(order('DELIVERED', { __claim: { return: { claimStatus } } }))).toBe(true);
    },
  );

  it.each(['RETURN_REQUEST', 'COLLECTING', 'COLLECT_DONE', 'EXCHANGE_REDELIVERING'])(
    '배송완료라도 클레임이 진행 중(%s)이면 종결이 아니다',
    (claimStatus) => {
      // 🪤 COLLECT_DONE 은 수거만 끝난 상태다 — 'DONE' 부분 문자열로 완료 판정하면 여기서 틀린다.
      expect(isPostCloseTerminalOrder(order('DELIVERED', { __claim: { return: { claimStatus } } }))).toBe(false);
    },
  );

  it('클레임 상태를 못 읽으면 아직 움직이는 것으로 본다', () => {
    expect(isPostCloseTerminalOrder(order('DELIVERED', { __claim: { return: { claimQuantity: 1 } } }))).toBe(false);
  });

  it('주문 단위 클레임 상태가 끝나지 않았으면(구매확정 보류 등) 종결이 아니다', () => {
    expect(isPostCloseTerminalOrder(order('DELIVERED', { claimStatus: 'PURCHASE_DECISION_HOLDBACK' }))).toBe(false);
    expect(isPostCloseTerminalOrder(order('DELIVERED', { claimStatus: 'RETURN_DONE' }))).toBe(true);
  });
});

describe('nextAllTerminalMarker', () => {
  const NOW = kst(9, 6, 6, 30);
  const PREV = new Date(kst(9, 3, 6, 30));

  it('처음 전부 종결이면 실행 시작 시각으로 찍는다', () => {
    expect(nextAllTerminalMarker({ previous: null, complete: true, allOrdersTerminal: true, nowMs: NOW })).toEqual({
      next: new Date(NOW),
      change: 'marked',
    });
  });

  it('이미 찍혀 있으면 다시 찍지 않는다(+10일 기준점이 밀리지 않게)', () => {
    expect(nextAllTerminalMarker({ previous: PREV, complete: true, allOrdersTerminal: true, nowMs: NOW })).toEqual({
      next: PREV,
      change: 'kept',
    });
  });

  it('온전한 응답에 움직이는 주문이 있으면 지운다', () => {
    expect(nextAllTerminalMarker({ previous: PREV, complete: true, allOrdersTerminal: false, nowMs: NOW })).toEqual({
      next: null,
      change: 'cleared',
    });
  });

  it('모자란 응답은 판단하지 않는다', () => {
    expect(nextAllTerminalMarker({ previous: PREV, complete: false, allOrdersTerminal: true, nowMs: NOW })).toEqual({
      next: PREV,
      change: 'kept',
    });
    expect(nextAllTerminalMarker({ previous: null, complete: false, allOrdersTerminal: true, nowMs: NOW })).toEqual({
      next: null,
      change: 'kept',
    });
  });
});

describe('postCloseCandidateEndDateFloor', () => {
  it('종결 미관측 상한 15일 + 종결 후 10일 + 여유 1일 = 26일', () => {
    const now = kst(9, 30, 6, 30);
    expect(postCloseCandidateEndDateFloor(now).getTime()).toBe(now - 26 * DAY);
  });
});
