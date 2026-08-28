// 주문관리 4개 액션 버튼(주문확인/발주요청/송장회신/송장등록) 감사 로그의 순수 로직.
//
// 각 버튼 핸들러의 결과 shape가 제각각(SSE confirmCount / 이메일 성패 / 송장 발견수 /
// dispatch 청크 집계)이라, 여기서 OrderActionLogInput 하나로 정규화한다. 컴포넌트(1197줄)에
// 매핑 로직이 흩어지는 것을 막고 상태 도출을 단위 테스트 대상으로 고립시키기 위함.
//
// 이 모듈은 순수 함수만 담는다(fetch·DB 없음). 실제 기록은 클라이언트가 이 결과를
// POST /order-converter/api/action-log 로 보내고, 라우트가 actor·저장을 담당한다.

export type OrderAction =
  | 'CONFIRM_ORDER' // 주문확인 — 발주확인 + 발주서 생성/다운로드
  | 'REQUEST_PO' // 발주요청 — 발주서 메일 발송
  | 'FETCH_INVOICE' // 송장회신 — 회신 메일에서 송장 파싱
  | 'REGISTER_INVOICE' // 송장등록 — 네이버 발송처리(배송중 전이)
  | 'DELAY_DISPATCH'; // 발송지연 — 네이버 발송지연 안내(고객 알림 즉시 발송)

export type OrderActionStatus = 'OK' | 'PARTIAL' | 'ERROR';

export const ORDER_ACTIONS: readonly OrderAction[] = [
  'CONFIRM_ORDER',
  'REQUEST_PO',
  'FETCH_INVOICE',
  'REGISTER_INVOICE',
  'DELAY_DISPATCH',
] as const;

export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
  CONFIRM_ORDER: '주문확인',
  REQUEST_PO: '발주요청',
  FETCH_INVOICE: '송장회신',
  REGISTER_INVOICE: '송장등록',
  DELAY_DISPATCH: '발송지연',
};

export interface OrderActionLogInput {
  campaignId: string | null;
  campaignName: string;
  action: OrderAction;
  status: OrderActionStatus;
  successCount: number;
  failCount: number;
  skipCount: number;
  errorMessage: string | null;
  details: Record<string, unknown> | null;
}

interface CampaignRef {
  id?: string | null;
  name: string;
}

// details.failed / skipped 배열이 비정상적으로 커지는 것을 방지하는 상한(실무상 실패는 소수).
const DETAIL_LIST_CAP = 100;

function normId(id?: string | null): string | null {
  return id && id.trim() ? id.trim() : null;
}

function clampCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
  return v < 0 ? 0 : v;
}

function trimError(msg?: string | null): string | null {
  if (!msg) return null;
  const t = String(msg).trim();
  return t ? t.slice(0, 500) : null;
}

/**
 * 성공/실패 카운트 기반 상태 도출(주문확인·송장등록 공용).
 * 실패가 하나라도 있으면 성공이 함께 있으면 PARTIAL, 아니면 ERROR. 실패 0이면 OK.
 * (스킵은 상태에 영향 없음 — 이미 배송중 등 정상 사유이므로.)
 */
export function deriveCountStatus(successCount: number, failCount: number): OrderActionStatus {
  if (clampCount(failCount) > 0) {
    return clampCount(successCount) > 0 ? 'PARTIAL' : 'ERROR';
  }
  return 'OK';
}

/**
 * 주문확인(handleDownloadExcel) — 발주서는 내려받되 스토어 발주확인이 일부 실패할 수 있다.
 * fatalError(스트림/네트워크 실패로 다운로드 자체가 무산)면 전량 실패로 기록한다.
 */
export function buildConfirmOrderLog(args: {
  campaign: CampaignRef;
  confirmSuccessCount?: number;
  confirmFailCount?: number;
  /**
   * 네이버가 성공·실패 어느 목록에도 담지 않고 조용히 누락한 "확인 대기" 건 수
   * (막 결제돼 아직 발주확인 불가). 실패가 아니므로 status를 ERROR/PARTIAL로 뒤집지 않되,
   * skipCount로 기록해 로그에 "스킵 N"으로 남긴다 — 잔여 미확인이 무증상으로 묻히지 않게.
   */
  confirmDeferredCount?: number;
  confirmFirstError?: string | null;
  fatalError?: string | null;
}): OrderActionLogInput {
  const { campaign } = args;
  if (args.fatalError) {
    return {
      campaignId: normId(campaign.id),
      campaignName: campaign.name,
      action: 'CONFIRM_ORDER',
      status: 'ERROR',
      successCount: 0,
      failCount: 0,
      skipCount: 0,
      errorMessage: trimError(args.fatalError),
      details: null,
    };
  }
  const successCount = clampCount(args.confirmSuccessCount);
  const failCount = clampCount(args.confirmFailCount);
  const deferredCount = clampCount(args.confirmDeferredCount);
  return {
    campaignId: normId(campaign.id),
    campaignName: campaign.name,
    action: 'CONFIRM_ORDER',
    status: deriveCountStatus(successCount, failCount),
    successCount,
    failCount,
    skipCount: deferredCount,
    errorMessage: failCount > 0 ? trimError(args.confirmFirstError) : null,
    details: null,
  };
}

/**
 * 발주요청(send-email) — 메일 발송 성패. 성공 건수는 발주서에 실린 상품주문 수(orderCount)를
 * 반영한다. orderCount가 없으면(구경로·미상) 성공을 1로 폴백해 "성공=최소 1건"만 보장한다.
 */
export function buildRequestPoLog(args: {
  campaign: CampaignRef;
  ok: boolean;
  orderCount?: number | null;
  errorMessage?: string | null;
  fileName?: string | null;
  toEmail?: string | null;
}): OrderActionLogInput {
  const details: Record<string, unknown> = {};
  if (args.fileName) details.fileName = args.fileName;
  if (args.toEmail) details.toEmail = args.toEmail;
  const resolvedCount = clampCount(args.orderCount);
  const successCount = args.ok ? (resolvedCount > 0 ? resolvedCount : 1) : 0;
  return {
    campaignId: normId(args.campaign.id),
    campaignName: args.campaign.name,
    action: 'REQUEST_PO',
    status: args.ok ? 'OK' : 'ERROR',
    successCount,
    failCount: args.ok ? 0 : 1,
    skipCount: 0,
    errorMessage: args.ok ? null : trimError(args.errorMessage) ?? '메일 발송 실패',
    details: Object.keys(details).length ? details : null,
  };
}

/**
 * 송장회신(fetch-emails) — 발견형 액션. 송장 N건 확보면 OK, 파일은 받았으나 0건이면
 * "성공 위장 금지" 원칙대로 ERROR(사유 보존), 메일/첨부 자체가 없으면 ERROR.
 */
export function buildFetchInvoiceLog(args: {
  campaign: CampaignRef;
  trackingCount: number;
  hadAttachment: boolean;
  fileName?: string | null;
  error?: string | null;
}): OrderActionLogInput {
  const trackingCount = clampCount(args.trackingCount);
  let status: OrderActionStatus;
  let errorMessage: string | null;
  if (!args.hadAttachment) {
    status = 'ERROR';
    errorMessage = trimError(args.error) ?? '회신 메일/첨부를 찾지 못함';
  } else if (trackingCount === 0) {
    status = 'ERROR';
    errorMessage = trimError(args.error) ?? '첨부는 받았으나 송장번호 0건';
  } else {
    status = 'OK';
    errorMessage = null;
  }
  const details: Record<string, unknown> = {};
  if (args.fileName) details.fileName = args.fileName;
  return {
    campaignId: normId(args.campaign.id),
    campaignName: args.campaign.name,
    action: 'FETCH_INVOICE',
    status,
    successCount: trackingCount,
    failCount: 0,
    skipCount: 0,
    errorMessage,
    details: Object.keys(details).length ? details : null,
  };
}

/**
 * 송장등록(submitTrackingData → dispatch 청크 집계) — 이 실사고의 핵심 액션.
 * 중복 송장 등으로 인한 부분 실패가 failed[]로 잡혀 여기 details.failed에 보존된다.
 */
export function buildRegisterInvoiceLog(args: {
  campaign: CampaignRef;
  successCount: number;
  failCount: number;
  skipCount: number;
  failed?: Array<{ productOrderId?: string; reason?: string }>;
  skipped?: Array<{ productOrderId?: string; reason?: string }>;
  firstFailReason?: string | null;
  fileName?: string | null;
}): OrderActionLogInput {
  const successCount = clampCount(args.successCount);
  const failCount = clampCount(args.failCount);
  const skipCount = clampCount(args.skipCount);
  const details: Record<string, unknown> = {};
  const failed = (args.failed ?? []).slice(0, DETAIL_LIST_CAP);
  const skipped = (args.skipped ?? []).slice(0, DETAIL_LIST_CAP);
  if (failed.length) details.failed = failed;
  if (skipped.length) details.skipped = skipped;
  if (args.fileName) details.fileName = args.fileName;
  return {
    campaignId: normId(args.campaign.id),
    campaignName: args.campaign.name,
    action: 'REGISTER_INVOICE',
    status: deriveCountStatus(successCount, failCount),
    successCount,
    failCount,
    skipCount,
    errorMessage:
      failCount > 0
        ? trimError(args.firstFailReason) ?? trimError(failed[0]?.reason) ?? '송장등록 일부 실패'
        : null,
    details: Object.keys(details).length ? details : null,
  };
}

/**
 * 발송지연(DelayDispatchModal → delay-dispatch 청크 집계) — 송장등록 빌더와 동일 shape.
 * 고객에게 취소 불가능한 알림이 즉시 나가는 액션이라, 어느 주문이 왜 실패/스킵됐는지와
 * 어떤 발송예정일·사유로 안내했는지를 details에 보존한다(사후 감사 목적).
 */
export function buildDelayDispatchLog(args: {
  campaign: CampaignRef;
  successCount: number;
  failCount: number;
  skipCount: number;
  failed?: Array<{ productOrderId?: string; reason?: string }>;
  skipped?: Array<{ productOrderId?: string; reason?: string }>;
  firstFailReason?: string | null;
  /** 고객에게 안내된 새 발송예정일(KST ISO) — 재알림 등 사후 추적용으로 details에 보존 */
  dispatchDueDate?: string | null;
  /** 지연 사유 enum(PRODUCT_PREPARE 등) */
  delayedDispatchReason?: string | null;
}): OrderActionLogInput {
  const successCount = clampCount(args.successCount);
  const failCount = clampCount(args.failCount);
  const skipCount = clampCount(args.skipCount);
  const details: Record<string, unknown> = {};
  const failed = (args.failed ?? []).slice(0, DETAIL_LIST_CAP);
  const skipped = (args.skipped ?? []).slice(0, DETAIL_LIST_CAP);
  if (failed.length) details.failed = failed;
  if (skipped.length) details.skipped = skipped;
  if (args.dispatchDueDate) details.dispatchDueDate = args.dispatchDueDate;
  if (args.delayedDispatchReason) details.delayedDispatchReason = args.delayedDispatchReason;
  return {
    campaignId: normId(args.campaign.id),
    campaignName: args.campaign.name,
    action: 'DELAY_DISPATCH',
    status: deriveCountStatus(successCount, failCount),
    successCount,
    failCount,
    skipCount,
    errorMessage:
      failCount > 0
        ? trimError(args.firstFailReason) ?? trimError(failed[0]?.reason) ?? '발송지연 안내 일부 실패'
        : null,
    details: Object.keys(details).length ? details : null,
  };
}

/** POST 본문 검증(서버 라우트에서 재사용). 유효하면 정규화 결과, 아니면 null. */
export function sanitizeActionLogInput(raw: unknown): OrderActionLogInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r.action;
  const status = r.status;
  if (typeof action !== 'string' || !ORDER_ACTIONS.includes(action as OrderAction)) return null;
  if (status !== 'OK' && status !== 'PARTIAL' && status !== 'ERROR') return null;
  const campaignName =
    typeof r.campaignName === 'string' && r.campaignName.trim() ? r.campaignName.trim() : null;
  if (!campaignName) return null;
  const details =
    r.details && typeof r.details === 'object' && !Array.isArray(r.details)
      ? (r.details as Record<string, unknown>)
      : null;
  return {
    campaignId: normId(typeof r.campaignId === 'string' ? r.campaignId : null),
    campaignName,
    action: action as OrderAction,
    status: status as OrderActionStatus,
    successCount: clampCount(r.successCount),
    failCount: clampCount(r.failCount),
    skipCount: clampCount(r.skipCount),
    errorMessage: trimError(typeof r.errorMessage === 'string' ? r.errorMessage : null),
    details,
  };
}
