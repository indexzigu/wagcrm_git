/**
 * 발주요청 **클라이언트 공용** 계약 — 데스크톱 발송 창(`EmailSendModal`)과 모바일 간편 전송 시트
 * (`mobile-purchase-order-sheet`)가 같은 라우트(`purchase-order` GET/POST · `send-email`)를 부르므로
 * 응답 모양·파일 변환·메일 폼 조립을 한 곳에 둔다. 2026-10-23 표준 리뷰: 두 화면이 같은 타입·헬퍼를
 * 손으로 들고 있었고 `Availability` 가 이미 갈라지기 시작했다(hand-rolled SSOT copy).
 *
 * ⚠️ 이 파일은 **클라이언트 번들에 실린다** — 서버 전용 모듈(네이버 클라이언트·prisma·bcrypt 사슬)을
 * 가져오지 말 것. 타입 import 만 허용.
 */
import type { DroppedOrder, PurchaseOrderPreviewRow } from './purchase-order-rows';
import type { PurchaseOrderPreviewSummary } from '@/components/crm/shipping/modals/PurchaseOrderPreview';

export type PurchaseOrderSource = 'prepared' | 'live';

/** `purchase-order` GET(출처 없음) 의 `availability`. `reason`·`message` 는 불가일 때만 온다. */
export type PurchaseOrderAvailability = {
  available: boolean;
  reason?: string;
  message?: string;
  asOfIso: string | null;
};

/** `purchase-order` GET?source= 의 미리보기 응답. */
export type PurchaseOrderPreviewResponse = {
  source: PurchaseOrderSource;
  asOfIso: string;
  rows: PurchaseOrderPreviewRow[];
  summary: PurchaseOrderPreviewSummary;
  empty: { message: string; noWork: boolean } | null;
};

export type PurchaseOrderConfirmSummary = {
  requested: number;
  succeeded: number;
  failed: number;
  firstError: string;
};

export type PurchaseOrderSendResult = {
  sentCount: number;
  fileName: string;
  confirm: PurchaseOrderConfirmSummary;
  dropped: DroppedOrder[];
};

/** 확정은 끝났는데 메일만 실패했을 때 쥐고 있는 것 — 재발송은 이걸로만 한다(확정 반복 금지). */
export type PurchaseOrderPendingMail = {
  file: File;
  orderIdsCsv: string;
  result: PurchaseOrderSendResult;
};

export const DROP_REASON_LABEL: Record<DroppedOrder['reason'], string> = {
  'status-changed': '취소·변경됨',
  'not-returned': '네이버 응답 없음',
  'already-requested': '이미 발주요청됨',
};

export function base64ToFile(base64: string, name: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data && typeof data.error === 'string' && data.error) || fallback;
}

/** `send-email` 멀티파트 — 필드 집합의 정본. `productOrderIds` 는 발송 성공 시 배송대기 스탬프에 쓰인다. */
export function buildSendEmailFormData(input: {
  file: File;
  to: string;
  cc?: string;
  subject: string;
  message: string;
  campaignId: string;
  orderIdsCsv: string;
}): FormData {
  const formData = new FormData();
  formData.append('file', input.file);
  formData.append('to', input.to);
  if (input.cc) formData.append('cc', input.cc);
  formData.append('subject', input.subject);
  formData.append('message', input.message);
  formData.append('campaignId', input.campaignId);
  if (input.orderIdsCsv) formData.append('productOrderIds', input.orderIdsCsv);
  return formData;
}

/**
 * 발주요청 흐름의 **화면 문구** SSOT — 데스크톱 발송 창·모바일 간편 전송 시트가 함께 쓴다(오너 선택
 * 2026-10-23 「1안」). 동사는 오너가 이미 매일 누르는 두 버튼 이름 그대로다:
 *   - 「주문확인」 = 네이버 발주확인 단계(데스크톱 「주문확인」 버튼과 같은 동작)
 *   - 「발주요청」 = 발주서 메일을 브랜드사로 보내는 동작(데스크톱 진입 버튼·작업 기록·경과일 표시와 같은 이름)
 * ⛔ 이 흐름에서 「발송」을 쓰지 말 것 — 앱의 「발송」은 택배 쪽(「발송처리」 송장 등록 · 상태 「발송대기/발송완료」)
 *    뜻이라, 메일 보내기에 쓰면 「발송 완료」가 「택배가 나갔다」로 읽힌다(ss-ux 검토 2026-10-23).
 */
export const PURCHASE_ORDER_COPY = {
  /** 진입 버튼(데스크톱 카드·모바일 상세 시트) */
  entry: '발주요청',
  /** 확정 버튼 — 주문확인이 필요한 행이 있으면 두 동작을 한 번에 한다 */
  commit: (needsConfirm: boolean) => (needsConfirm ? '주문확인하고 발주요청' : '발주요청'),
  /** 「주문확인 필요」 세는 칸·표 열 이름 */
  needsConfirm: '주문확인',
  committing: '주문확인 중…',
  /** 데스크톱 진행 제목(공간이 넉넉한 쪽) — 같은 단계의 긴 이름 */
  committingDetail: '네이버 주문확인과 발주서 작성 중…',
  sending: '발주요청 중…',
  successTitle: '발주요청 메일 보냄',
  failureTitle: '발주요청 메일 실패',
  mailFailedFallback: '발주요청 메일을 보내지 못했습니다.',
  commitFailedFallback: '주문확인·발주서 작성에 실패했습니다.',
  retryMail: '메일 다시 보내기',
} as const;
