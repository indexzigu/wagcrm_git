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
