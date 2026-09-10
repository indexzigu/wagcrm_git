import { deriveClaimsFromOrder } from './claim-derive';

/**
 * 마감 캠페인 사후 취소·교환 확인(`syncPostCloseCancellations`, 매일 06:30 정산 크론)의 확인 기간 판정.
 *
 * 오너 확정(2026-09-11): 마감 후 취소·교환은 하루 한 번 확인이면 충분하고, 확인 기간은 **캠페인
 * 마지막 주문이 배송완료된 시점 +10일**까지다. 취소·교환은 배송완료로부터 최대 15일(자동 구매확정
 * 기간 · 법적 교환의무 7일) 안에 끝나고, 그 뒤 건은 정산 때 수동으로 조정한다.
 *
 * 네이버 응답의 배송완료 일시는 쓰지 않는다 — 코드가 그 필드를 읽은 적이 없고 문서로도 확인되지
 * 않았다. 대신 매일 이미 받아오는 전 주문 상태가 **전부 종결인 것을 처음 본 시각**
 * (`OrderCampaign.cachedPostCloseAllTerminalAt`)을 기준으로 삼는다. 관측이 하루 1회라 최대 하루
 * 늦게 잡히고, 추가 요청은 없다.
 *
 * 종결이 영영 관측되지 않는 캠페인(탈퇴 구매자 주문은 커머스API 가 돌려주지 않는다 · 배송 추적이
 * 멈춘 주문)은 **판매 종료 +15일 안전선**에서 멈춘다. 이 안전선이 종전 90일 창(구 레포에서 넘어온
 * 상수로 오너 결정 기록이 없었다)을 대체한다.
 *
 * 설계 정본: docs/private/plans/2026-09-11-post-close-cancel-window.md (로컬 전용)
 */
export const POST_CLOSE_DAYS_AFTER_ALL_TERMINAL = 10;
export const POST_CLOSE_MAX_DAYS_AFTER_SALE_END = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 더 움직이지 않는 주문 상태. DELIVERED 는 진행 중인 클레임이 없을 때만 종결이다(아래). */
const TERMINAL_ORDER_STATUSES = new Set([
  'PURCHASE_DECIDED',
  'CANCELED',
  'CANCELED_BY_NOPAYMENT',
  'RETURNED',
  'EXCHANGED',
]);

/**
 * 이 주문이 더 이상 취소·교환으로 움직이지 않는가.
 * 배송완료 뒤 반품·교환 요청이 들어와도 주문 상태는 DELIVERED 로 남고 클레임만 움직인다 —
 * 클레임 완료 판정은 claim-derive SSOT(`isCompleted`)를 그대로 쓴다(여기에 상태 목록을 베끼지 말 것).
 */
export function isPostCloseTerminalOrder(order: any): boolean {
  const status = order?.productOrderStatus;
  if (TERMINAL_ORDER_STATUSES.has(status)) return true;
  if (status === 'DELIVERED') return deriveClaimsFromOrder(order).every((claim) => claim.isCompleted);
  return false;
}

export type PostCloseCheckDecision =
  | 'check' // 오늘 조회한다
  | 'skip-finalized' // 정산 락 상태에서 확정 계산을 마쳤다(기존 규칙, #48·#49)
  | 'stop-after-terminal' // 전 주문 종결을 처음 본 지 10일이 지났다
  | 'stop-backstop'; // 판매 종료 +15일 안전선을 넘었다

export function decidePostCloseCheck(
  input: {
    saleEndMs: number | null;
    allTerminalAtMs: number | null;
    locked: boolean;
    finalized: boolean;
    includeLocked: boolean;
  },
  nowMs: number,
): PostCloseCheckDecision {
  // 안전선은 수동 재계산 레버(includeLocked)도 넘지 않는다 — 넘기면 창 밖 마감 캠페인 전부를 다시
  // 조회하게 된다. 판매 종료일을 모르면 안전선을 세울 수 없으므로 멈추는 쪽으로 잡는다(요청 0).
  if (input.saleEndMs == null) return 'stop-backstop';
  if (nowMs > input.saleEndMs + POST_CLOSE_MAX_DAYS_AFTER_SALE_END * DAY_MS) return 'stop-backstop';
  if (input.includeLocked) return 'check';
  if (input.locked && input.finalized) return 'skip-finalized';
  if (input.allTerminalAtMs != null && nowMs >= input.allTerminalAtMs + POST_CLOSE_DAYS_AFTER_ALL_TERMINAL * DAY_MS) {
    return 'stop-after-terminal';
  }
  return 'check';
}

/**
 * 대상 조회의 판매 종료일 하한. 안전선에 하루 여유를 둔 거친 필터다 — 종료일 해석(KST 종일 포함 ·
 * 정밀 종료시각)은 캠페인마다 다르므로 정밀 판정은 `decidePostCloseCheck` 가 한다.
 */
export function postCloseCandidateEndDateFloor(nowMs: number): Date {
  return new Date(nowMs - (POST_CLOSE_MAX_DAYS_AFTER_SALE_END + 1) * DAY_MS);
}
