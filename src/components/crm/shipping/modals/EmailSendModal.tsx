import React, { useState, useEffect, useRef } from 'react';
import { DialogTitle } from '@/components/ui/dialog';
import { ShippingDialogFrame } from './ShippingDialogFrame';
import { PurchaseOrderPreview, type PurchaseOrderPreviewSummary } from './PurchaseOrderPreview';
import { formatLastSyncLabel } from '@/lib/date-utils';
import type { DroppedOrder, PurchaseOrderPreviewRow } from '@/lib/order-converter/purchase-order-rows';

/**
 * 발주요청(발주서 첨부 메일) 창 — 발주 자동화 2단계(오너 승인 2026-10-06).
 *
 * 자동 연동은 세 단계다. **네이버 쓰기와 메일은 3단계에서만** 일어난다.
 *  1. 출처 선택 — 「준비본 사용」(저장된 주문 사본, 네이버 요청 0) 또는 「지금 다시 수집」(종전 조회).
 *     준비본은 캠페인 스위치·동기화 신선도 판정(prepared-po SSOT)이 허락할 때만 고를 수 있다.
 *  2. 미리보기 — 실릴 주문을 표로 본다(`purchase-order` GET, 쓰기 없음).
 *  3. 확정 — 미리보기에서 본 주문 **그대로** 발주확인 → 재조회로 다시 만든 엑셀(`purchase-order` POST)
 *     → 메일(`send-email`). 메일만 실패하면 파일을 쥔 채 「메일 다시 보내기」로 재시도한다 — 처음부터
 *     다시 하면 발주확인이 되풀이된다.
 *
 * ⛔ 2단계 확정 버튼은 `<form>` 제출로 되돌리지 말 것 — 입력칸의 Enter 한 번이 네이버 발주확인 + 브랜드사
 *    메일 발송이 된다(되돌릴 수 없다). 이 창에는 form 이 없고 모든 버튼이 `type="button"` 이다.
 * 수동 첨부는 종전 그대로다(원본 파일을 검증만 하고 보낸다 — 네이버 쓰기 없음).
 */
export type StepStatus =
  | 'IDLE'
  | 'LOADING_PREVIEW'
  | 'PREVIEW'
  | 'ANALYZING'
  | 'COMMITTING'
  | 'SENDING'
  | 'SUCCESS'
  | 'MAIL_FAILED';

type EmailSendModalProps = {
  campaignId: string;
  defaultTo?: string;
  defaultCc?: string;
  defaultSubject?: string;
  defaultMessage?: string;
  // 발주서 파일명 기본값(서버 provider 기준으로 order-dashboard가 미리 조합). 자동 연동 파일명 프리뷰용.
  defaultFileName?: string;
  onClose: () => void;
  onSuccess: () => void;
  // 발주요청 감사 로그용 — 발송 성패(성공/실패)와 발주서에 실린 상품주문 수를 상위에 통지한다.
  onResult?: (ok: boolean, errorMessage?: string, fileName?: string, orderCount?: number) => void;
  addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
};

type Source = 'prepared' | 'live';
type Availability = { available: boolean; reason?: string; message?: string; asOfIso: string | null };
type Preview = {
  source: Source;
  asOfIso: string;
  rows: PurchaseOrderPreviewRow[];
  summary: PurchaseOrderPreviewSummary;
  empty: { message: string; noWork: boolean } | null;
};
type ConfirmSummary = { requested: number; succeeded: number; failed: number; firstError: string };
type SendResult = { sentCount: number; fileName: string; confirm: ConfirmSummary; dropped: DroppedOrder[] };
type PendingMail = { file: File; orderIdsCsv: string; result: SendResult };

const DROP_REASON_LABEL: Record<DroppedOrder['reason'], string> = {
  'status-changed': '취소·변경됨',
  'not-returned': '네이버 응답 없음',
  'already-requested': '이미 발주요청됨',
};

// 사용자가 편집한 파일명에 .xlsx 확장자를 보장한다(빈 값이면 폴백 이름을 그대로 쓰도록 빈 문자열 반환).
function ensureXlsxName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /\.xlsx$/i.test(trimmed) ? trimmed : `${trimmed}.xlsx`;
}

function base64ToFile(base64: string, name: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data && typeof data.error === 'string' && data.error) || fallback;
}

const inputClass =
  'w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50';

export default function EmailSendModal({
  campaignId,
  defaultTo = '',
  defaultCc = '',
  defaultSubject = '',
  defaultMessage = '',
  defaultFileName = '',
  onClose,
  onSuccess,
  onResult,
  addToast
}: EmailSendModalProps) {
  const [emailToStr, setEmailToStr] = useState(defaultTo);
  const [emailCcStr, setEmailCcStr] = useState(defaultCc);
  const [emailSubject, setEmailSubject] = useState(defaultSubject);
  const [emailMessage, setEmailMessage] = useState(defaultMessage);

  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [includePending, setIncludePending] = useState(false);
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  // 발주서 파일명 — 자동 연동은 서버 조합 기본값, 수동 첨부는 원본 파일명을 기본값으로 하되
  // 사용자가 편집하면(touched) 그 값을 유지한다(원본 그대로 발송 원칙과의 균형).
  const [fileName, setFileName] = useState(defaultFileName);
  const fileNameTouchedRef = useRef(false);
  useEffect(() => {
    if (fileNameTouchedRef.current) return;
    if (mode === 'manual') setFileName(manualFile?.name ?? '');
    else setFileName(defaultFileName);
  }, [mode, manualFile, defaultFileName]);

  const [step, setStep] = useState<StepStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);

  // 1단계 — 준비본 가용성(DB 읽기만, 네이버 0)과 출처 선택.
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [source, setSource] = useState<Source>('live');
  // 2단계 — 미리보기와 빈 칸 확인.
  const [preview, setPreview] = useState<Preview | null>(null);
  const [missingAck, setMissingAck] = useState(false);
  // 3단계 — 결과(성공·메일 실패 재시도).
  const [result, setResult] = useState<SendResult | null>(null);
  const [pendingMail, setPendingMail] = useState<PendingMail | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/order-converter/api/campaigns/${campaignId}/purchase-order`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const next: Availability | null = res.ok && data?.availability ? data.availability : null;
        setAvailability(next);
        if (next?.available) setSource('prepared');
      } catch (err) {
        console.error('[EmailSendModal] 준비본 상태 조회 실패:', err);
        if (!cancelled) setAvailability(null);
      } finally {
        if (!cancelled) setAvailabilityLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  // 단계가 바뀌면 그 단계 제목으로 포커스를 옮긴다 — 스크린리더가 새 단계를 읽고, 발송 버튼이 첫 포커스가 되지 않는다.
  const stepKind =
    step === 'PREVIEW'
      ? 'preview'
      : step === 'SUCCESS' || step === 'MAIL_FAILED'
        ? 'result'
        : mode === 'auto' && (step === 'COMMITTING' || step === 'SENDING')
          ? 'progress'
          : 'choose';
  useEffect(() => {
    if (stepKind !== 'choose') stepHeadingRef.current?.focus();
  }, [stepKind]);

  const isBusy = step === 'LOADING_PREVIEW' || step === 'ANALYZING' || step === 'COMMITTING' || step === 'SENDING';
  const isDone = step === 'SUCCESS' || step === 'MAIL_FAILED';

  const getStepProgress = () => {
    switch (step) {
      case 'IDLE': return 0;
      case 'LOADING_PREVIEW':
      case 'ANALYZING': return 25;
      case 'PREVIEW': return 50;
      case 'COMMITTING': return 70;
      case 'SENDING':
      case 'MAIL_FAILED': return 90;
      case 'SUCCESS': return 100;
      default: return 0;
    }
  };
  const stageLabels = mode === 'auto' ? ['미리보기', '발주확인·발주서', '메일 발송'] : ['검증', '발주서', '메일 발송'];
  const stageIndex = step === 'LOADING_PREVIEW' || step === 'PREVIEW' || step === 'ANALYZING' ? 0 : step === 'COMMITTING' ? 1 : step === 'SENDING' || step === 'MAIL_FAILED' ? 2 : step === 'SUCCESS' ? 3 : -1;

  const handleClose = () => {
    // 발주확인이 일어난 뒤(성공·메일 실패)에는 목록을 새로 읽어야 배송 단계가 맞는다 — 상위 onSuccess 가 그 일을 한다.
    if (isDone) onSuccess();
    else onClose();
  };

  const validateMailFields = (): boolean => {
    const missing: [string, React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>][] = [];
    if (!emailToStr.trim()) missing.push(['수신 이메일 주소', toInputRef]);
    if (!emailSubject.trim()) missing.push(['메일 제목', subjectInputRef]);
    if (!emailMessage.trim()) missing.push(['메일 본문', messageInputRef]);
    if (missing.length === 0) return true;
    setError(`${missing.map(([label]) => label).join(', ')}을(를) 입력하세요.`);
    missing[0][1].current?.focus();
    return false;
  };

  const handleManualFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setManualFile(file);
    setManualError(null);
    setError(null);
    setStep('IDLE');
  };

  /** 메일 발송(자동·수동 공용). 실패하면 던진다. */
  const postMail = async (file: File, orderIdsCsv: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('to', emailToStr);
    if (emailCcStr) formData.append('cc', emailCcStr);
    formData.append('subject', emailSubject);
    formData.append('message', emailMessage);
    formData.append('campaignId', campaignId);
    // 배송대기 스탬프용 상품주문번호. 서버가 발송 성공 시 사용.
    if (orderIdsCsv) formData.append('productOrderIds', orderIdsCsv);
    const res = await fetch('/order-converter/api/send-email', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await readError(res, '이메일 발송에 실패했습니다.'));
  };

  // ── 자동 연동 ────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    if (isBusy) return;
    setError(null);
    if (!validateMailFields()) return;
    setStep('LOADING_PREVIEW');
    try {
      const res = await fetch(
        `/order-converter/api/campaigns/${campaignId}/purchase-order?source=${source}&includePending=${includePending}`,
      );
      if (!res.ok) throw new Error(await readError(res, '미리보기를 불러오지 못했습니다.'));
      const data = (await res.json()) as Preview;
      setPreview(data);
      setMissingAck(false);
      setStep('PREVIEW');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '미리보기를 불러오지 못했습니다.');
      setStep('IDLE');
    }
  };

  const sendCommittedMail = async (mail: PendingMail) => {
    setStep('SENDING');
    try {
      await postMail(mail.file, mail.orderIdsCsv);
      setPendingMail(null);
      setResult(mail.result);
      setStep('SUCCESS');
      onResult?.(true, undefined, mail.file.name, mail.result.sentCount);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '이메일 발송에 실패했습니다.';
      setPendingMail(mail);
      setResult(mail.result);
      setError(`메일 발송에 실패했습니다: ${message}`);
      setStep('MAIL_FAILED');
      onResult?.(false, message);
    }
  };

  const handleCommit = async () => {
    // 클릭 즉시 단계를 바꿔 중복 클릭을 막는다(이 버튼은 되돌릴 수 없는 외부 효과를 낸다).
    if (!preview || step !== 'PREVIEW') return;
    setError(null);
    setStep('COMMITTING');
    try {
      const res = await fetch(`/order-converter/api/campaigns/${campaignId}/purchase-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: preview.source,
          productOrderIds: preview.rows.map((r) => r.productOrderId),
          confirmIds: preview.rows.filter((r) => r.needsConfirm).map((r) => r.productOrderId),
          includePending,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((typeof data?.error === 'string' && data.error) || '발주 확정에 실패했습니다.');
      }
      const chosenName = ensureXlsxName(fileName) || data.fileName;
      const file = base64ToFile(data.fileBase64, chosenName);
      const ids: string[] = Array.isArray(data.productOrderIds) ? data.productOrderIds : [];
      await sendCommittedMail({
        file,
        orderIdsCsv: ids.join(','),
        result: { sentCount: ids.length, fileName: file.name, confirm: data.confirm, dropped: data.dropped ?? [] },
      });
    } catch (err: unknown) {
      // 확정 실패 — 발주확인이 일부 일어났을 수 있으니 미리보기부터 다시 받게 한다(상태가 바뀌었을 수 있다).
      const message = err instanceof Error ? err.message : '발주 확정에 실패했습니다.';
      setError(`${message} 미리보기를 다시 불러와 확인하세요.`);
      setPreview(null);
      setStep('IDLE');
      onResult?.(false, message);
    }
  };

  // ── 수동 첨부(종전 그대로) ────────────────────────────────────────────────
  const handleManualSend = async () => {
    if (isBusy || !manualFile) return;
    setError(null);
    if (!validateMailFields()) return;
    try {
      // 수동 첨부는 재변환하지 않는다 — 원본 파일을 그대로 발송하되,
      // 발송 전 데이터 정합성 + 캠페인 대조 검증만 수행한다(하드 차단).
      setStep('ANALYZING');
      const formData = new FormData();
      formData.append('file', manualFile);
      const res = await fetch(`/order-converter/api/campaigns/${campaignId}/validate`, { method: 'POST', body: formData });
      const validation = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(validation.error || '검증에 실패했습니다.');
      if (!validation.ok) {
        throw new Error((validation.errors && validation.errors.length ? validation.errors : ['검증에 실패했습니다.']).join('\n'));
      }
      // 경고(부분 발송/누락 등)는 차단하지 않고 알림만.
      if (Array.isArray(validation.warnings) && validation.warnings.length > 0) addToast(validation.warnings[0], 'info');
      const orderIdsCsv = Array.isArray(validation.matchedOrderIds) ? validation.matchedOrderIds.join(',') : '';
      const chosenName = ensureXlsxName(fileName);
      const file = chosenName && chosenName !== manualFile.name ? new File([manualFile], chosenName, { type: manualFile.type }) : manualFile;
      setStep('SENDING');
      await postMail(file, orderIdsCsv);
      const sentCount = orderIdsCsv ? orderIdsCsv.split(',').filter(Boolean).length : 0;
      setResult({ sentCount, fileName: file.name, confirm: { requested: 0, succeeded: 0, failed: 0, firstError: '' }, dropped: [] });
      setStep('SUCCESS');
      onResult?.(true, undefined, file.name, sentCount);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '발송에 실패했습니다.';
      console.error(err);
      onResult?.(false, message);
      setManualError(message);
      setManualFile(null);
      setStep('IDLE');
    }
  };

  const needsConfirmCount = preview?.summary.needsConfirmCount ?? 0;
  const commitBlocked =
    !preview || preview.rows.length === 0 || (preview.summary.missingCount > 0 && !missingAck) || isBusy;
  const recipientLabel = emailToStr.trim() || '(수신 주소 없음)';

  return (
    <ShippingDialogFrame onClose={handleClose} canClose={!isBusy} className="sm:max-w-2xl">
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl">
          <DialogTitle className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            발주서 첨부 발송
          </DialogTitle>
          {!isBusy && (
            <button
              onClick={handleClose}
              type="button"
              aria-label="닫기"
              className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-5 pt-4 pb-1">
          {/* 트랙 = 발송까지 남은 단계라 보여야 한다: slate-100(흰 표면 1.10:1) → slate-300.
              진행 채움은 범주색 네이비(bg-primary, 트랙 대비 7.62 — 진행 단계 라벨 text-primary 와 같은 색). 종전 blue-500/600 은 P8 축 밖 hue.
              완료(SUCCESS)는 100% 라 트랙이 안 보이므로 기준은 흰 배경 대비다 — 바로 아래 「완료」 라벨과 같은 성공 토큰
              (bg-status-success #047857: 흰 배경 5.48 · 트랙 3.69) — 오너 결정 2026-10-06. */}
          <div className="relative h-2 w-full bg-slate-300 rounded-full overflow-hidden">
            <div
              className={`absolute top-0 left-0 h-full w-full origin-left rounded-full transition-[transform,background-color] duration-500 ${step === 'SUCCESS' ? 'bg-status-success' : 'bg-primary'}`}
              style={{ transform: `scaleX(${getStepProgress() / 100})` }}
            />
          </div>
          <div className="flex justify-between mt-2 px-1 text-[10px] font-bold text-slate-500 transition-colors">
            {/* 진행 중 단계는 네이비 + 밑줄 — 완료 단계(slate-700)와 색만으로는 구분되지 않는다(#148). */}
            <span className={stageIndex === 0 ? 'text-primary underline decoration-2 underline-offset-4' : stageIndex > 0 ? 'text-slate-700' : ''}>{stageLabels[0]}</span>
            <span className={stageIndex === 1 ? 'text-primary underline decoration-2 underline-offset-4' : stageIndex > 1 ? 'text-slate-700' : ''}>{stageLabels[1]}</span>
            <span className={stageIndex === 2 ? 'text-primary underline decoration-2 underline-offset-4' : stageIndex > 2 ? 'text-slate-700' : ''}>{stageLabels[2]}</span>
            <span className={step === 'SUCCESS' ? 'text-status-success' : ''}>완료</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-5 space-y-4 min-h-[320px]">
          {error && stepKind !== 'result' && (
            <p role="alert" className="whitespace-pre-line rounded-xl border border-destructive/25 bg-white p-3 text-xs font-semibold text-status-urgent-text">
              {error}
            </p>
          )}

          {stepKind === 'choose' && (
            <>
              {mode === 'auto' ? (
                <fieldset className="space-y-2" disabled={isBusy}>
                  <legend className="mb-2 text-sm font-semibold text-slate-800">발주서에 담을 주문</legend>
                  {availabilityLoading ? (
                    <div className="space-y-2" aria-hidden="true">
                      <div className="h-[58px] rounded-xl bg-slate-100" />
                      <div className="h-[58px] rounded-xl bg-slate-100" />
                    </div>
                  ) : (
                    <>
                      <label
                        className={`flex items-start gap-2 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-focus-ring ${source === 'prepared' ? 'border-primary bg-primary/[0.04]' : 'border-slate-200'} ${availability?.available ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                      >
                        <input
                          type="radio"
                          name="po-source"
                          value="prepared"
                          checked={source === 'prepared'}
                          disabled={!availability?.available}
                          onChange={() => setSource('prepared')}
                          aria-describedby="po-source-prepared-desc"
                          className="mt-0.5 accent-primary"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-800">준비본 사용</span>
                          <span id="po-source-prepared-desc" className="block text-xs text-slate-600">
                            {availability?.available && availability.asOfIso
                              ? `${formatLastSyncLabel(availability.asOfIso)} 기준 저장된 주문으로 만듭니다. 네이버 요청을 쓰지 않습니다.`
                              : availability?.message || '준비본 상태를 확인하지 못했습니다. 지금 다시 수집으로 진행하세요.'}
                          </span>
                        </span>
                      </label>
                      <label
                        className={`flex items-start gap-2 rounded-xl border p-3 cursor-pointer focus-within:ring-2 focus-within:ring-focus-ring ${source === 'live' ? 'border-primary bg-primary/[0.04]' : 'border-slate-200'}`}
                      >
                        <input
                          type="radio"
                          name="po-source"
                          value="live"
                          checked={source === 'live'}
                          onChange={() => setSource('live')}
                          aria-describedby="po-source-live-desc"
                          className="mt-0.5 accent-primary"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-800">지금 다시 수집</span>
                          <span id="po-source-live-desc" className="block text-xs text-slate-600">
                            네이버에서 주문을 지금 다시 불러옵니다(프록시 요청을 씁니다).
                          </span>
                        </span>
                      </label>
                    </>
                  )}
                  <div className="flex items-center gap-2 pt-1 px-1">
                    <input
                      type="checkbox"
                      id="includePending"
                      checked={includePending}
                      onChange={e => setIncludePending(e.target.checked)}
                      className="w-4 h-4 accent-primary bg-white border-slate-300 rounded focus:ring-focus-ring focus:ring-2 disabled:opacity-50"
                    />
                    <label htmlFor="includePending" className="text-xs font-bold text-slate-600 cursor-pointer">
                      배송대기건 포함
                    </label>
                  </div>
                </fieldset>
              ) : (
                <div className="flex items-center bg-slate-50 border border-slate-100 p-3 rounded-xl min-h-[46px] text-[11px] text-slate-500 font-medium">
                  {manualError ? (
                    <span role="alert" className="whitespace-pre-line font-bold text-red-600">{manualError}</span>
                  ) : manualFile ? (
                    <span className="text-slate-700">
                      수동 첨부: <span className="font-bold truncate max-w-[220px] inline-block align-bottom">{manualFile.name}</span>
                    </span>
                  ) : (
                    <>수동으로 첨부된 파일이 없습니다. 하단 버튼을 통해 첨부해주세요.</>
                  )}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label htmlFor="email-send-filename" className="block text-xs font-bold text-slate-600 mb-1.5">발주서 파일명</label>
                  <input
                    id="email-send-filename"
                    type="text"
                    value={fileName}
                    onChange={e => { fileNameTouchedRef.current = true; setFileName(e.target.value); }}
                    disabled={isBusy}
                    className={inputClass}
                    placeholder="예: 발주서_브랜드_와이그라운드_셀러_250710.xlsx"
                  />
                  <p className="mt-1 px-1 text-[10px] text-slate-500">
                    {mode === 'manual'
                      ? '첨부한 원본 파일명입니다. 필요하면 수정하세요. (.xlsx 자동 부여)'
                      : '기본값은 거래처 표기명을 따릅니다. 브랜드명 등으로 바꾸려면 수정하세요. (.xlsx 자동 부여)'}
                  </p>
                </div>
                <div>
                  <label htmlFor="email-send-to" className="block text-xs font-bold text-slate-600 mb-1.5">수신 이메일 주소</label>
                  <input
                    id="email-send-to"
                    ref={toInputRef}
                    type="text"
                    value={emailToStr}
                    onChange={e => setEmailToStr(e.target.value)}
                    disabled={isBusy}
                    className={inputClass}
                  placeholder="예: target@domain.com, (여러 명일 경우 쉼표로 구분)"
                  />
                </div>
                <div>
                  <label htmlFor="email-send-cc" className="block text-xs font-bold text-slate-600 mb-1.5">참조 이메일 주소 (선택)</label>
                  <input
                    id="email-send-cc"
                    type="text"
                    value={emailCcStr}
                    onChange={e => setEmailCcStr(e.target.value)}
                    disabled={isBusy}
                    className={inputClass}
                  placeholder="예: cc@domain.com"
                  />
                </div>
                <div>
                  <label htmlFor="email-send-subject" className="block text-xs font-bold text-slate-600 mb-1.5">메일 제목</label>
                  <input
                    id="email-send-subject"
                    ref={subjectInputRef}
                    type="text"
                    value={emailSubject}
                    onChange={e => setEmailSubject(e.target.value)}
                    disabled={isBusy}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="email-send-body" className="block text-xs font-bold text-slate-600 mb-1.5">메일 본문</label>
                  <textarea
                    id="email-send-body"
                    ref={messageInputRef}
                    rows={4}
                    value={emailMessage}
                    onChange={e => setEmailMessage(e.target.value)}
                    disabled={isBusy}
                    className={`${inputClass} resize-none`}
                  />
                </div>
              </div>
            </>
          )}

          {stepKind === 'preview' && preview && (
            <div className="space-y-3">
              <h3 ref={stepHeadingRef} tabIndex={-1} className="text-sm font-semibold text-slate-800 focus:outline-none">
                미리보기 · {preview.source === 'prepared' ? '준비본' : '지금 다시 수집'} ({formatLastSyncLabel(preview.asOfIso)} 기준)
              </h3>
              <p className="text-xs text-slate-600 break-all">
                받는 사람 {recipientLabel}{emailCcStr.trim() ? ` · 참조 ${emailCcStr.trim()}` : ''} · 제목 {emailSubject}
                <span className="text-slate-500"> (수정하려면 뒤로)</span>
              </p>
              {preview.empty ? (
                <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">{preview.empty.message}</p>
              ) : (
                <PurchaseOrderPreview rows={preview.rows} summary={preview.summary} />
              )}
              {!preview.empty && preview.summary.missingCount > 0 && (
                <label id="po-missing-ack-label" className="flex items-start gap-2 text-xs font-semibold text-status-caution-text">
                  <input
                    type="checkbox"
                    checked={missingAck}
                    onChange={e => setMissingAck(e.target.checked)}
                    id="po-missing-ack" className="mt-0.5 w-4 h-4 accent-primary"
                  />
                  빈 칸이 있는 {preview.summary.missingCount}건을 그대로 보냅니다.
                </label>
              )}
              {!preview.empty && (
                <p id="po-commit-notice" className="text-xs text-slate-700">
                  {needsConfirmCount > 0
                    ? `누르면 네이버에서 ${needsConfirmCount}건이 발주확인 처리되고, 발주서가 ${recipientLabel}(으)로 메일 발송됩니다. 되돌릴 수 없습니다.`
                    : `누르면 발주서가 ${recipientLabel}(으)로 메일 발송됩니다. 되돌릴 수 없습니다.`}
                </p>
              )}
            </div>
          )}

          {stepKind === 'progress' && (
            <div role="status">
              <h3 ref={stepHeadingRef} tabIndex={-1} className="text-sm font-normal text-slate-700 focus:outline-none">
                {step === 'COMMITTING' ? '네이버 발주확인과 발주서 작성 중...' : '메일 발송 중...'}
              </h3>
            </div>
          )}

          {stepKind === 'result' && result && (
            <div className="space-y-3">
              <h3 ref={stepHeadingRef} tabIndex={-1} className="text-sm font-semibold text-slate-800 focus:outline-none">
                {step === 'SUCCESS' ? `발송 완료 · 상품주문 ${result.sentCount.toLocaleString('ko-KR')}건` : '메일 발송 실패'}
              </h3>
              {mode === 'auto' && (
                <p className="text-xs text-slate-700">
                  네이버 발주확인 {result.confirm.succeeded.toLocaleString('ko-KR')}건 완료
                  {result.confirm.requested === 0 ? ' (확인할 주문 없음)' : ''}
                </p>
              )}
              {step === 'MAIL_FAILED' && (
                <div role="alert" className="rounded-xl bg-status-urgent-bg p-3 text-xs text-status-urgent-text">
                  <p className="font-bold">{error || '메일 발송에 실패했습니다.'}</p>
                  <p className="mt-1">
                    발주서는 만들어졌고 네이버 발주확인도 끝났습니다. 「메일 다시 보내기」를 누르면 같은 파일로 메일만 다시 보냅니다.
                    보내지 않고 닫으면 이 주문들은 다음 발주요청에 다시 잡힙니다.
                  </p>
                </div>
              )}
              {result.confirm.failed > 0 && (
                <p className="rounded-xl bg-status-caution-bg p-3 text-xs font-semibold text-status-caution-text">
                  네이버 발주확인에 실패한 주문 {result.confirm.failed}건이 있습니다{result.confirm.firstError ? `: ${result.confirm.firstError}` : ''}.
                  주문확인 버튼으로 다시 확인하세요.
                </p>
              )}
              {result.dropped.length > 0 && (
                <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-700">
                  <p className="font-semibold">미리보기 이후 바뀐 주문 {result.dropped.length}건은 발주서에서 제외했습니다.</p>
                  <ul className="mt-1 list-disc pl-4">
                    {result.dropped.map((d) => (
                      <li key={d.productOrderId}>
                        {d.recipientName || d.productOrderId} · {DROP_REASON_LABEL[d.reason]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-between items-center gap-4">
          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx, .xls"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) {
                setMode('manual');
                handleManualFileUpload(e);
              }
              e.target.value = '';
            }}
            disabled={isBusy}
          />

          {stepKind === 'choose' ? (
            <div className="flex items-center bg-slate-200/50 p-1 rounded-lg border border-slate-200/50 shrink-0">
              <button
                type="button"
                onClick={() => { setMode('auto'); setManualFile(null); setManualError(null); setError(null); setStep('IDLE'); }}
                className={`px-3 py-1.5 text-[11px] font-bold rounded-md transition-colors ${mode === 'auto' ? 'bg-white text-slate-800 shadow-soft-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                disabled={isBusy}
              >
                자동 연동
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`px-3 py-1.5 text-[11px] font-bold rounded-md transition-colors ${mode === 'manual' ? 'bg-white text-slate-800 shadow-soft-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                disabled={isBusy}
              >
                수동 첨부
              </button>
            </div>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {stepKind === 'choose' && (
              <>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={handleClose}
                  className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-[background-color,opacity] disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={mode === 'auto' ? handlePreview : handleManualSend}
                  disabled={isBusy || (mode === 'auto' && availabilityLoading) || (mode === 'manual' && !manualFile)}
                  className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity] flex items-center gap-2 disabled:opacity-50"
                >
                  {isBusy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  <span>
                    {mode === 'auto'
                      ? step === 'LOADING_PREVIEW' ? '불러오는 중...' : '미리보기'
                      : step === 'ANALYZING' ? '검증 중...' : step === 'SENDING' ? '발송 중...' : '발송'}
                  </span>
                </button>
              </>
            )}
            {stepKind === 'preview' && (
              <>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => { setPreview(null); setError(null); setStep('IDLE'); }}
                  className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-[background-color,opacity] disabled:opacity-50"
                >
                  뒤로
                </button>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={commitBlocked}
                  aria-describedby={preview?.empty ? undefined : preview && preview.summary.missingCount > 0 ? 'po-commit-notice po-missing-ack-label' : 'po-commit-notice'}
                  className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity] flex items-center gap-2 disabled:opacity-50"
                >
                  {isBusy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  <span>{needsConfirmCount > 0 ? '발주확인하고 발송' : '발송'}</span>
                </button>
              </>
            )}
            {stepKind === 'result' && (
              <>
                {step === 'MAIL_FAILED' && pendingMail && (
                  <button
                    type="button"
                    onClick={() => { setError(null); void sendCommittedMail(pendingMail); }}
                    className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity]"
                  >
                    메일 다시 보내기
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-[background-color,opacity]"
                >
                  {step === 'MAIL_FAILED' ? '메일 보내지 않고 닫기' : '닫기'}
                </button>
              </>
            )}
          </div>
        </div>
    </ShippingDialogFrame>
  );
}
