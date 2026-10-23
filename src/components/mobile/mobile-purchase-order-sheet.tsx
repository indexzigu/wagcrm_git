"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MobileSheetCard } from "./mobile-sheet-card";
import { MobileSheetHeader } from "./mobile-sheet-header";
import type { MobilePurchaseOrderInfo } from "@/lib/mobile-campaign-sales";
import { buildPurchaseOrderMailDefaults } from "@/lib/order-converter/purchase-order-mail-defaults";
// ⛔ `@/lib/order-converter/prepared-po` 를 여기서 가져오지 말 것 — 서버 전용 의존(네이버 클라이언트·bcrypt)이
//    딸려 와 클라이언트 번들이 깨진다(실측 2026-10-23). 시각 포맷은 의존 0 인 형제 모듈에서.
import { formatKstShort } from "@/lib/order-converter/prepared-po-format";
import {
  DROP_REASON_LABEL,
  PURCHASE_ORDER_COPY,
  base64ToFile,
  buildSendEmailFormData,
  readApiError as readError,
  type PurchaseOrderAvailability as Availability,
  type PurchaseOrderPendingMail as PendingMail,
  type PurchaseOrderPreviewResponse as Preview,
  type PurchaseOrderSendResult as SendResult,
  type PurchaseOrderSource as Source,
} from "@/lib/order-converter/purchase-order-client";

/**
 * 모바일 발주서 **간편 전송** 시트 (오너 확정 2026-10-23: "모바일에서는 간편 전송 기능(축소판),
 * 부득이하게 필요할 때 사용하려는 기능 — 받는 사람 칸 정도 수정이면 괜찮다").
 *
 * 데스크톱 발송 창(`EmailSendModal`)의 3단계(출처 → 미리보기 → 확정·발송)를 **미리보기 한 화면 +
 * 버튼 하나**로 접은 것이다. 서버는 데스크톱과 **같은 라우트**를 쓴다 — 새 쓰기 경로를 만들지 않는다:
 *   GET  /order-converter/api/campaigns/{OrderCampaign.id}/purchase-order            (준비본 가능 여부)
 *   GET  …/purchase-order?source=prepared|live&includePending=false                 (미리보기, 네이버 쓰기 0)
 *   POST …/purchase-order {source, productOrderIds, confirmIds, includePending:false} (발주확인 + xlsx)
 *   POST /order-converter/api/send-email (multipart)                                 (메일 + 배송대기 스탬프)
 *
 * 접은 것(PC 전용으로 남긴 것): 출처 선택(준비본 가능하면 자동으로 준비본, 아니면 지금 수집) ·
 * 제목/본문/파일명 편집 · 「이미 발주요청한 주문 포함」 · 엑셀 직접 첨부.
 * 남긴 것: 받는 사람·참조 편집(메일 실패 뒤에도 — 참조는 오너 확정 2026-10-23 추가) · 누락(수령인·연락처·
 * 주소) 동의 1회 · 메일만 실패 시 재발송(확정 반복 없음).
 *
 * ⛔ 확정 버튼을 `<form>` 제출로 만들지 말 것 — 입력칸 Enter 한 번이 네이버 발주확인 + 브랜드사 메일이
 *    된다(되돌릴 수 없다). 데스크톱 창과 같은 이유로 이 시트에는 form 이 없고 버튼은 전부 type="button".
 * ⛔ 진행 중(busy)에는 닫히지 않는다 — 닫았다 다시 열면 미리보기가 새로 떠 **두 번째 발주확인**이 가능해진다
 *    (code-reviewer 2026-10-23 HIGH). 데스크톱의 `canClose={!isBusy}` 와 같은 가드.
 */

type Step =
  | "LOADING"
  | "PREVIEW"
  | "COMMITTING"
  | "SENDING"
  | "SUCCESS"
  | "MAIL_FAILED"
  | "ERROR";

// 응답 타입·드롭 사유 라벨·파일 변환은 purchase-order-client.ts(데스크톱 창과 공유)에서 온다.

const FIELD_CLASS =
  "min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-base text-foreground placeholder:text-slate-500 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring aria-invalid:border-status-urgent disabled:opacity-50";

/**
 * 받는 사람 형식 — 서버(`send-email`)는 비어 있는지만 보므로, 되돌릴 수 없는 발주확인 **전에** 여기서 막는다.
 * 쉼표·세미콜론으로 여러 명도 허용(데스크톱과 같다). 느슨한 검사다 — 오타 전부를 잡는 게 아니라
 * `a@b`·공백 섞임처럼 메일 서버가 거절할 모양만 거른다.
 */
export function isMailRecipientListValid(raw: string): boolean {
  const parts = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
}

/** 서버 사유 문장 중 첫 문장만 — 둘째 문장은 PC 설정 안내라 여기서 할 수 있는 행동이 아니다. */
function firstSentence(text: string): string {
  const idx = text.indexOf(". ");
  return idx > 0 ? text.slice(0, idx + 1) : text;
}

export type MobilePurchaseOrderSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 매출 응답의 `purchaseOrder` — 주문캠페인 id·수신처·셀러명 */
  purchaseOrder: MobilePurchaseOrderInfo;
  /** 헤더 부제용 캠페인 이름(딜 · 셀러) */
  campaignLabel: string;
  /** 메일까지 성공했을 때 — 상위 시트가 매출 현황을 다시 읽는다(배송대기 수가 바뀐다) */
  onSent?: (sentCount: number) => void;
};

export function MobilePurchaseOrderSheet({
  open,
  onOpenChange,
  purchaseOrder,
  campaignLabel,
  onSent,
}: MobilePurchaseOrderSheetProps) {
  const [step, setStep] = useState<Step>("LOADING");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const [to, setTo] = useState(purchaseOrder.toEmail ?? "");
  // 참조 — 비워도 된다(그때는 cc 를 보내지 않는다). 형식은 받는 사람과 같은 규칙으로 검사한다.
  const [cc, setCc] = useState(purchaseOrder.ccEmail ?? "");
  const [ccError, setCcError] = useState<string | null>(null);
  const [missingAck, setMissingAck] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [pendingMail, setPendingMail] = useState<PendingMail | null>(null);
  const toInputRef = useRef<HTMLInputElement | null>(null);
  const ccInputRef = useRef<HTMLInputElement | null>(null);
  // 미리보기 로드 취소 신호 — 효과와 「다시 불러오기」가 같은 ref 를 쓰므로 늦게 끝난 옛 로드가 새 상태를 덮지 않는다.
  const loadSignalRef = useRef<{ cancelled: boolean }>({ cancelled: true });
  // 되돌릴 수 없는 구간(발주확인·메일) 재진입 가드 — 상태(step)보다 먼저 닫힌다.
  const inFlightRef = useRef(false);
  const apiBase = `/order-converter/api/campaigns/${purchaseOrder.orderCampaignId}/purchase-order`;

  const busy = step === "LOADING" || step === "COMMITTING" || step === "SENDING";

  const loadPreview = useCallback(async () => {
    loadSignalRef.current.cancelled = true;
    const signal = { cancelled: false };
    loadSignalRef.current = signal;
    setStep("LOADING");
    setError(null);
    setToError(null);
    setCcError(null);
    setPreview(null);
    setMissingAck(false);
    try {
      // ① 준비본 가능 여부 — 가능하면 네이버 조회 0 인 준비본, 아니면 지금 수집(PC 와 같은 우선순위).
      const availRes = await fetch(apiBase);
      const availData = await availRes.json().catch(() => ({}));
      if (signal.cancelled) return;
      const avail: Availability | null =
        availRes.ok && availData?.availability ? availData.availability : null;
      setAvailability(avail);
      const source: Source = avail?.available ? "prepared" : "live";
      // ② 미리보기 — 읽기 전용. 이미 발주요청한 주문은 포함하지 않는다(PC 기본값과 같다).
      const res = await fetch(`${apiBase}?source=${source}&includePending=false`);
      if (signal.cancelled) return;
      if (!res.ok) throw new Error(await readError(res, "미리보기를 불러오지 못했습니다."));
      const data = (await res.json()) as Preview;
      if (signal.cancelled) return;
      setPreview(data);
      setStep("PREVIEW");
    } catch (err) {
      if (signal.cancelled) return;
      setError(err instanceof Error ? err.message : "미리보기를 불러오지 못했습니다.");
      setStep("ERROR");
    }
  }, [apiBase]);

  useEffect(() => {
    if (!open) return;
    // 진행 중에는 닫히지 않으므로(아래 가드) 여기 올 때는 항상 새 세션이다.
    // ⚠️ 열린 채로 상위가 매출을 다시 읽어 저장된 기본 수신처가 바뀌면 두 칸이 그 값으로 초기화된다
    //    (편집 중이던 값이 사라진다). 실제로는 시트가 열린 동안 상위 재조회가 수신처를 바꾸는 경로가 없다.
    setTo(purchaseOrder.toEmail ?? "");
    setCc(purchaseOrder.ccEmail ?? "");
    setResult(null);
    setPendingMail(null);
    void loadPreview();
    return () => {
      loadSignalRef.current.cancelled = true;
    };
  }, [open, purchaseOrder.toEmail, purchaseOrder.ccEmail, loadPreview]);

  /** 닫기 가드 — 발주확인·메일이 진행 중이면 닫지 않는다(닫았다 열면 두 번째 발주확인이 가능해진다). */
  const handleOpenChange = (next: boolean) => {
    if (!next && (busy || inFlightRef.current)) return;
    onOpenChange(next);
  };

  /** 수신처 검사 — 되돌릴 수 없는 발주확인 **전에** 돈다. 받는 사람은 필수, 참조는 비어 있으면 통과. */
  const validateRecipients = (): boolean => {
    let nextToError: string | null = null;
    if (!to.trim()) nextToError = "받는 사람 이메일을 입력하세요.";
    else if (!isMailRecipientListValid(to)) nextToError = "이메일 주소 형식을 확인하세요.";
    const nextCcError = cc.trim() && !isMailRecipientListValid(cc) ? "참조 이메일 주소 형식을 확인하세요." : null;
    setToError(nextToError);
    setCcError(nextCcError);
    if (nextToError) toInputRef.current?.focus();
    else if (nextCcError) ccInputRef.current?.focus();
    return !nextToError && !nextCcError;
  };

  const postMail = async (file: File, orderIdsCsv: string) => {
    const defaults = buildPurchaseOrderMailDefaults(purchaseOrder.sellerName);
    const formData = buildSendEmailFormData({
      file,
      to: to.trim(),
      cc: cc.trim() || undefined,
      subject: defaults.subject,
      message: defaults.message,
      campaignId: purchaseOrder.orderCampaignId,
      orderIdsCsv,
    });
    const res = await fetch("/order-converter/api/send-email", { method: "POST", body: formData });
    if (!res.ok) throw new Error(await readError(res, PURCHASE_ORDER_COPY.mailFailedFallback));
  };

  const sendCommittedMail = async (mail: PendingMail) => {
    inFlightRef.current = true;
    setStep("SENDING");
    setError(null);
    try {
      await postMail(mail.file, mail.orderIdsCsv);
      setPendingMail(null);
      setResult(mail.result);
      setStep("SUCCESS");
      onSent?.(mail.result.sentCount);
    } catch (err) {
      const message = err instanceof Error ? err.message : PURCHASE_ORDER_COPY.mailFailedFallback;
      setPendingMail(mail);
      setResult(mail.result);
      setError(message);
      setStep("MAIL_FAILED");
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleRetryMail = () => {
    if (!pendingMail || step !== "MAIL_FAILED") return;
    if (!validateRecipients()) return;
    void sendCommittedMail(pendingMail);
  };

  const handleCommit = async () => {
    // 클릭 즉시 단계를 바꿔 중복 탭을 막는다 — 이 버튼은 되돌릴 수 없는 외부 효과를 낸다.
    if (!preview || step !== "PREVIEW" || inFlightRef.current) return;
    if (!validateRecipients()) return;
    inFlightRef.current = true;
    setError(null);
    setStep("COMMITTING");
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: preview.source,
          productOrderIds: preview.rows.map((r) => r.productOrderId),
          confirmIds: preview.rows.filter((r) => r.needsConfirm).map((r) => r.productOrderId),
          includePending: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((typeof data?.error === "string" && data.error) || PURCHASE_ORDER_COPY.commitFailedFallback);
      }
      const file = base64ToFile(data.fileBase64, data.fileName);
      const ids: string[] = Array.isArray(data.productOrderIds) ? data.productOrderIds : [];
      inFlightRef.current = false;
      await sendCommittedMail({
        file,
        orderIdsCsv: ids.join(","),
        result: { sentCount: ids.length, fileName: file.name, confirm: data.confirm, dropped: data.dropped ?? [] },
      });
    } catch (err) {
      // 확정 실패 — 발주확인이 일부 일어났을 수 있으니 미리보기부터 다시 받게 한다.
      const message = err instanceof Error ? err.message : PURCHASE_ORDER_COPY.commitFailedFallback;
      inFlightRef.current = false;
      setError(`${message} 미리보기를 다시 불러와 확인하세요.`);
      setPreview(null);
      setStep("ERROR");
    }
  };

  const rows = preview?.rows ?? [];
  const summary = preview?.summary;
  const needsAck = (summary?.missingCount ?? 0) > 0;
  const canSend = step === "PREVIEW" && rows.length > 0 && (!needsAck || missingAck);
  // 버튼 이름과 그 아래 안내문은 같은 판정 하나로 갈린다 — 둘이 어긋나면 안내문이 거짓말을 한다.
  const needsConfirm = (summary?.needsConfirmCount ?? 0) > 0;
  const commitLabel = PURCHASE_ORDER_COPY.commit(needsConfirm);

  // 화면 분기 — 결과 카드는 재발송(SENDING + pendingMail) 중에도 유지된다(미리보기로 튀지 않는다).
  const showResult =
    result !== null && (step === "SUCCESS" || step === "MAIL_FAILED" || (step === "SENDING" && pendingMail !== null));
  const showPreview =
    preview !== null && !showResult && (step === "PREVIEW" || step === "COMMITTING" || step === "SENDING");
  const retrying = step === "SENDING" && !!pendingMail;

  const sourceLine = preview
    ? preview.source === "prepared"
      ? `준비본 · ${formatKstShort(preview.asOfIso)} 기준 · 네이버 조회 없음`
      : `지금 수집 · ${formatKstShort(preview.asOfIso)} 기준${
          availability && !availability.available && availability.message
            ? ` · ${firstSentence(availability.message)}`
            : ""
        }`
    : null;

  const recipientField = (
    <MobileSheetCard title="받는 곳" ariaLabel="받는 곳">
      <div className="flex flex-col gap-2 px-6 pb-5">
        <RecipientInput
          id="mobile-po-to"
          label="받는 사람"
          placeholder="브랜드 발주 메일 주소"
          inputRef={toInputRef}
          value={to}
          error={toError}
          disabled={busy}
          onChange={(value) => {
            setTo(value);
            if (toError) setToError(null);
          }}
        />
        <RecipientInput
          id="mobile-po-cc"
          label="참조"
          placeholder="비워 두면 참조 없이 보냅니다"
          inputRef={ccInputRef}
          value={cc}
          error={ccError}
          disabled={busy}
          onChange={(value) => {
            setCc(value);
            if (ccError) setCcError(null);
          }}
        />
        <p className="text-xs text-slate-500">여러 명은 쉼표(,)나 세미콜론(;)으로 구분합니다. 제목과 본문은 정해진 문구로 갑니다.</p>
      </div>
    </MobileSheetCard>
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="mobile-sheet-safe-bottom top-0 gap-0 overflow-y-auto rounded-none border-0 bg-slate-50 p-0"
      >
        <MobileSheetHeader
          title={PURCHASE_ORDER_COPY.entry}
          description={campaignLabel}
          closeLabel={`${PURCHASE_ORDER_COPY.entry} 닫기`}
        />

        <div className="flex flex-col gap-2.5 px-3 py-3">
          {step === "LOADING" ? (
            <MobileSheetCard ariaLabel="발주서 미리보기 불러오는 중" className="p-5">
              <div aria-busy="true" className="flex flex-col gap-3">
                <div className="h-5 w-1/2 animate-pulse rounded-md bg-slate-100" />
                <div className="h-3 w-full animate-pulse rounded-full bg-slate-100" />
                <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
              </div>
            </MobileSheetCard>
          ) : null}

          {step === "ERROR" ? (
            <MobileSheetCard ariaLabel="발주서 오류" className="p-5">
              <p className="text-[13px] font-medium text-status-urgent-text">{error}</p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11 w-full rounded-xl"
                onClick={() => void loadPreview()}
              >
                미리보기 다시 불러오기
              </Button>
            </MobileSheetCard>
          ) : null}

          {showPreview && preview && summary ? (
            <>
              <MobileSheetCard title="발주 미리보기" ariaLabel="발주 미리보기">
                <div className="flex flex-col gap-3 px-6 pb-5">
                  {preview.empty ? (
                    <p className="rounded-xl bg-slate-100 p-3 text-[13px] text-slate-600">{preview.empty.message}</p>
                  ) : (
                    <dl className="grid grid-cols-3 gap-2 text-center">
                      <Stat label="발주" value={`${summary.lineCount}건`} />
                      <Stat label={`${PURCHASE_ORDER_COPY.needsConfirm} 필요`} value={`${summary.needsConfirmCount}건`} />
                      <Stat
                        label="누락"
                        value={`${summary.missingCount}건`}
                        tone={summary.missingCount > 0 ? "warn" : undefined}
                      />
                    </dl>
                  )}
                  <p className="text-xs text-slate-500">{sourceLine}</p>
                  {/* 슬롯은 항상 둔다(레이아웃 안정 규칙 — 조건부 마운트 금지). 누락 0건이면 체크 없는 안내줄. */}
                  {needsAck ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-xl bg-status-caution-bg p-3 text-xs text-status-caution-text">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        checked={missingAck}
                        onChange={(e) => setMissingAck(e.target.checked)}
                        disabled={busy}
                        aria-label="빈 칸 주문 포함 동의"
                      />
                      <span>
                        수령인·연락처·주소가 빈 주문 {summary.missingCount}건이 있습니다. 빈 칸 그대로 발주서에 싣는
                        것에 동의합니다.
                      </span>
                    </label>
                  ) : (
                    <p className="flex min-h-11 items-center rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                      수령인·연락처·주소가 빈 주문 없음
                    </p>
                  )}
                </div>
              </MobileSheetCard>

              {recipientField}

              {error ? (
                <p role="alert" className="px-2 text-xs text-status-urgent-text">
                  {error}
                </p>
              ) : null}

              <Button
                type="button"
                onClick={() => void handleCommit()}
                disabled={!canSend || busy}
                aria-busy={busy}
                className="min-h-12 w-full rounded-xl text-sm font-bold"
              >
                {step === "COMMITTING"
                  ? PURCHASE_ORDER_COPY.committing
                  : step === "SENDING"
                    ? PURCHASE_ORDER_COPY.sending
                    : commitLabel}
              </Button>
              {/* 안내문은 버튼이 실제로 하는 일과 같아야 한다 — 발주확인이 필요 없으면 메일만 나간다. */}
              <p className="px-2 text-center text-xs text-slate-500">
                {needsConfirm
                  ? "누르면 네이버 주문확인과 브랜드사 발주요청 메일이 함께 일어나며 되돌릴 수 없습니다."
                  : "누르면 브랜드사로 발주요청 메일이 나가며 되돌릴 수 없습니다."}
              </p>
            </>
          ) : null}

          {showResult && result ? (
            <>
              <MobileSheetCard
                title={step === "SUCCESS" ? PURCHASE_ORDER_COPY.successTitle : PURCHASE_ORDER_COPY.failureTitle}
                ariaLabel={step === "SUCCESS" ? PURCHASE_ORDER_COPY.successTitle : PURCHASE_ORDER_COPY.failureTitle}
              >
                <div className="flex flex-col gap-3 px-6 pb-5">
                  {step === "SUCCESS" ? (
                    <p className="rounded-xl bg-status-success-bg p-3 text-[13px] font-medium text-status-success">
                      발주서 {result.sentCount}건 · {to.trim()}
                    </p>
                  ) : (
                    <p
                      role="alert"
                      className="rounded-xl bg-status-urgent-bg p-3 text-[13px] font-medium text-status-urgent-text"
                    >
                      {error ?? PURCHASE_ORDER_COPY.mailFailedFallback}
                    </p>
                  )}
                  {result.confirm && result.confirm.requested > 0 ? (
                    <p className="text-xs text-slate-500">
                      네이버 {PURCHASE_ORDER_COPY.needsConfirm} {result.confirm.succeeded}/{result.confirm.requested}
                      {result.confirm.failed > 0 ? ` · 실패 ${result.confirm.failed}건` : ""}
                    </p>
                  ) : null}
                  {result.dropped.length > 0 ? (
                    <div className="rounded-xl bg-slate-100 p-3 text-xs text-slate-600">
                      <p className="font-semibold">발주서에서 빠진 주문 {result.dropped.length}건</p>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {result.dropped.map((d) => (
                          <li key={d.productOrderId}>
                            {d.recipientName || "알 수 없음"} · {DROP_REASON_LABEL[d.reason]}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {step === "SUCCESS" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-full rounded-xl"
                      onClick={() => handleOpenChange(false)}
                    >
                      닫기
                    </Button>
                  ) : (
                    <p className="text-xs text-status-caution-text">
                      네이버 주문확인은 끝났습니다. 아래 버튼은 메일만 다시 보내며 주문확인을 반복하지 않습니다. 보내지
                      않고 닫으면 이 주문들은 다음 발주요청에 다시 잡힙니다.
                    </p>
                  )}
                </div>
              </MobileSheetCard>

              {step !== "SUCCESS" ? (
                <>
                  {recipientField}
                  <Button
                    type="button"
                    onClick={handleRetryMail}
                    disabled={retrying}
                    aria-busy={retrying}
                    className="min-h-12 w-full rounded-xl text-sm font-bold"
                  >
                    {retrying ? PURCHASE_ORDER_COPY.sending : PURCHASE_ORDER_COPY.retryMail}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** 수신처 한 칸 — 라벨·입력·오류 줄(항상 자리를 둔다: 레이아웃 안정, 생기면 alert 로 낭독). */
function RecipientInput({
  id,
  label,
  placeholder,
  inputRef,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-err`}
        className={FIELD_CLASS}
      />
      <p id={`${id}-err`} role="alert" className="min-h-4 text-xs text-status-urgent-text">
        {error}
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={cn("rounded-xl bg-slate-50 px-2 py-2.5", tone === "warn" && "bg-status-caution-bg")}>
      <dt className="text-[10px] font-semibold text-slate-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-[15px] font-bold tabular-nums text-slate-800",
          tone === "warn" && "text-status-caution-text",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
