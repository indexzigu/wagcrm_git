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
 * 종결을 본 캠페인은 **그 시각 +10일**에 멈춘다 — 판매 종료일과 무관하다(공구는 판매 종료 뒤 배송이
 * 흔해서, 판매 종료 기준으로 자르면 늦게 배송된 캠페인의 10일이 잘린다).
 * 종결을 한 번도 못 본 캠페인(탈퇴 구매자 주문은 커머스API 가 돌려주지 않는다 · 배송 추적이 멈춘
 * 주문)은 **판매 종료 +15일**에서 멈춘다. 이 두 규칙이 종전 90일 창(구 레포에서 넘어온 상수로 오너
 * 결정 기록이 없었다)을 대체한다.
 *
 * 설계 정본: docs/private/plans/2026-09-11-post-close-cancel-window.md (로컬 전용)
 */
export const POST_CLOSE_DAYS_AFTER_ALL_TERMINAL = 10;
/** 종결을 한 번도 못 본 캠페인의 상한(판매 종료 기준). */
export const POST_CLOSE_MAX_DAYS_WITHOUT_TERMINAL = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 더 움직이지 않는 주문 상태. DELIVERED 는 클레임이 전부 끝났을 때만 종결이다(아래). */
const TERMINAL_ORDER_STATUSES = new Set([
  'PURCHASE_DECIDED',
  'CANCELED',
  'CANCELED_BY_NOPAYMENT',
  'RETURNED',
  'EXCHANGED',
]);

/**
 * 더 움직이지 않는 클레임 상태 — 완료 또는 거부.
 * ⛔ claim-derive 의 `isCompleted` 를 쓰지 말 것: 그쪽은 알림·접힘 UI 용 부분 문자열 판정('DONE' 포함)
 *    이라 `COLLECT_DONE`(수거만 끝나고 반품은 진행 중)을 완료로 읽어 +10일 시계를 일찍 켠다.
 * 목록에 없는 상태(요청·수거중·재배송중·미확인 null)는 **아직 움직이는 것**으로 본다 — 틀리면
 * 확인이 길어지는 쪽(요청 수 증가)이지 취소를 놓치는 쪽이 아니다. 상한은 판매 종료 +15일이 막는다.
 */
const FINISHED_CLAIM_STATUSES = new Set([
  'CANCEL_DONE',
  'RETURN_DONE',
  'EXCHANGE_DONE',
  'ADMIN_CANCEL_DONE',
  'CANCEL_REJECT',
  'RETURN_REJECT',
  'EXCHANGE_REJECT',
  'ADMIN_CANCEL_REJECT',
]);

/**
 * 이 주문이 더 이상 취소·교환으로 움직이지 않는가.
 * 배송완료 뒤 반품·교환 요청이 들어와도 주문 상태는 DELIVERED 로 남고 클레임만 움직인다 —
 * 클레임 상태 **추출**은 claim-derive SSOT(`deriveClaimsFromOrder`)를 쓰고, 끝났는지는 위 목록으로 본다.
 */
export function isPostCloseTerminalOrder(order: any): boolean {
  const status = order?.productOrderStatus;
  if (TERMINAL_ORDER_STATUSES.has(status)) return true;
  if (status === 'DELIVERED') {
    return deriveClaimsFromOrder(order).every((claim) => FINISHED_CLAIM_STATUSES.has(claim.claimStatus ?? ''));
  }
  return false;
}

export type PostCloseCheckDecision =
  | 'check' // 오늘 조회한다
  | 'skip-finalized' // 정산 락 상태에서 확정 계산을 마쳤다(기존 규칙, #48·#49)
  | 'stop-after-terminal' // 전 주문 종결을 처음 본 지 10일이 지났다
  | 'stop-backstop'; // 종결을 못 본 채 판매 종료 +15일을 넘었다

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
  if (input.allTerminalAtMs == null) {
    // 종결을 못 본 캠페인의 상한은 수동 재계산 레버(includeLocked)도 넘지 않는다 — 넘기면 후보 창의
    // 미종결 캠페인 전부를 다시 조회하게 된다. 판매 종료일을 모르면 상한을 세울 수 없으므로 멈춘다
    // (후보 조회가 `endDate` 로 걸러서 실제로는 오지 않는 경로다).
    if (input.saleEndMs == null) return 'stop-backstop';
    if (nowMs > input.saleEndMs + POST_CLOSE_MAX_DAYS_WITHOUT_TERMINAL * DAY_MS) return 'stop-backstop';
  } else if (!input.includeLocked && nowMs >= input.allTerminalAtMs + POST_CLOSE_DAYS_AFTER_ALL_TERMINAL * DAY_MS) {
    return 'stop-after-terminal';
  }
  if (input.includeLocked) return 'check';
  if (input.locked && input.finalized) return 'skip-finalized';
  return 'check';
}

export type AllTerminalMarkerChange = 'marked' | 'cleared' | 'kept';

/**
 * 조회 결과로 「전 주문 종결 최초 관측 시각」을 어떻게 바꿀지.
 * - 모자란 응답: 판단하지 않는다(그대로).
 * - 온전 + 전부 종결: 처음이면 `nowMs`(실행 시작 시각)로 찍고, 이미 있으면 유지한다 — 다시 찍으면
 *   +10일 기준점이 매일 밀린다. 실행 시작 시각으로 찍어야 +10일째 06:30 실행에서 정확히 멈춘다.
 * - 온전 + 움직이는 주문 있음(새 반품·교환 요청 등): 지워서 확인을 이어 간다. 지운 뒤 판매 종료
 *   +15일을 넘었으면 다음 회차에 상한에서 멈춘다 — 이번 회차 값에는 그 요청 수량이 이미 담긴다.
 */
export function nextAllTerminalMarker(input: {
  previous: Date | null;
  complete: boolean;
  allOrdersTerminal: boolean;
  nowMs: number;
}): { next: Date | null; change: AllTerminalMarkerChange } {
  const { previous, complete, allOrdersTerminal, nowMs } = input;
  if (!complete) return { next: previous, change: 'kept' };
  if (allOrdersTerminal) {
    return previous ? { next: previous, change: 'kept' } : { next: new Date(nowMs), change: 'marked' };
  }
  return previous ? { next: null, change: 'cleared' } : { next: null, change: 'kept' };
}

/**
 * 대상 조회의 판매 종료일 하한 — 종결 미관측 상한(15일) + 종결 후 확인(10일) + 여유 1일의 거친 창이다.
 * 종결은 늦어도 판매 종료 +15일 안에 찍히므로 그 +10일까지 담으려면 26일이 필요하다. 정밀 판정은
 * `decidePostCloseCheck` 가 캠페인마다 한다(창 안이라도 대부분은 조회 없이 멈춘다).
 */
export function postCloseCandidateEndDateFloor(nowMs: number): Date {
  return new Date(
    nowMs - (POST_CLOSE_MAX_DAYS_WITHOUT_TERMINAL + POST_CLOSE_DAYS_AFTER_ALL_TERMINAL + 1) * DAY_MS,
  );
}
