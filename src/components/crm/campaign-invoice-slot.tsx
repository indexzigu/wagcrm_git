"use client";

/**
 * 월정산 공급사 계산서 칸(T-240 후속) — 캠페인당 계산서 여러 장.
 *
 * 화면 원칙(오너 확정 2026-10-08, 시안 6차):
 * - 칸 안에는 제목 · 버튼 · 달별 줄(작성일 또는 한 낱말 상태)만. 설명 문장을 넣지 않는다.
 * - 풀이·세부(금액·품목명·승인번호·출처)는 줄에 마우스를 올리면(키보드 포커스·터치 포함) 뜨는
 *   작은 창에서. 그 창에는 조작을 넣지 않는다(`hover-card.tsx` 계약).
 * - 확인·직접 입력·「이 달은 계산서 없음」·취소는 「조회」가 여는 창 안에서만(오너 지시
 *   2026-08-15 — 칸에 승인 버튼을 따로 두지 않는다).
 * - 줄은 처음부터 달 수만큼 있고 내용만 바뀐다. 줄 높이는 고정이다(상태가 바뀌어도 칸이 흔들리지 않게).
 * 낱말·풀이·색의 정본은 `campaign-invoices.ts` 의 표다 — 여기서 문구를 새로 쓰지 말 것.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AUTO_RECORD_REVIEW_LABEL,
  INVOICE_MONTH_EMPTY_MARK,
  INVOICE_MONTH_HINT,
  INVOICE_MONTH_LABEL,
  INVOICE_MONTH_NOTE_HINT,
  INVOICE_MONTH_TONE,
  collectStatementExpectations,
  deriveInvoiceMonths,
  findInvoiceCandidates,
  formatInvoiceMonth,
  isInvoiceMonthDone,
  listYearMonths,
  matchesExpectedAmount,
  resolveInvoiceReview,
  summarizeInvoiceRows,
  INVOICE_AMOUNT_TOLERANCE_WON,
  type CampaignInvoiceRow,
  type CampaignInvoiceView,
  type InvoiceMailSummary,
  type InvoiceMonth,
  type InvoiceReviewAck,
  type RecordedMismatch,
  type StatementMailSummary,
} from "@/lib/campaign-invoices";
import type { ReceiptScanApiResponse } from "@/lib/tax-invoice-mail/board-evidence";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { toKstYmd } from "@/lib/date-utils";
import { INVOICE_LOOKUP_DAYS_AFTER_END } from "@/lib/tax-invoice-mail/invoice-lookup-scope";

type ApplicableView = Extract<CampaignInvoiceView, { applicable: true }>;

const DOT_CLASS: Record<"none" | "info" | "caution" | "slate", string> = {
  none: "",
  info: "bg-status-info",
  caution: "bg-status-caution",
  slate: "bg-slate-400",
};

const SCANNING_HINT = "메일함을 확인하고 있습니다.";
/** 자동 조회를 하지 않는 캠페인에서 메일함을 아직 안 본 달의 풀이(오너 확정 2026-10-21, `invoice-lookup-scope.ts`). */
/** 메일함 조회를 시도했는데 결과가 없는 달의 풀이 — 실패 사유는 토스트가 따로 알린다. */
const SCAN_FAILED_HINT = "메일함을 확인하지 못했습니다. 「조회」를 다시 눌러 주세요.";
const LOOKUP_IDLE_HINT = `정산 단계 캠페인만 판매 종료 후 ${INVOICE_LOOKUP_DAYS_AFTER_END}일까지 자동으로 메일함을 확인합니다. 「조회」를 누르면 지금 확인합니다.`;

function formatWon(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ko-KR")}원`;
}

function formatMonthDay(ymd: string | null): string {
  if (!ymd) return INVOICE_MONTH_EMPTY_MARK;
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}

const SOURCE_LABEL: Record<CampaignInvoiceRow["source"], string> = {
  MAIL: "발급 메일",
  MAIL_AUTO: "발급 메일(자동 기록)",
  MANUAL: "직접 입력",
};

/** 정산서 금액(T-242) 한 줄 — 「74,250원 · 지급일 10/20」(정산서는 브랜드가 보낸 확정 문서라 「예상」이라 부르지 않는다). */
function formatExpected(month: InvoiceMonth): string | null {
  const first = month.expected[0];
  if (!first) return null;
  const more = month.expected.length > 1 ? ` 외 ${month.expected.length - 1}건` : "";
  const due = first.dueDate ? ` · 지급일 ${formatMonthDay(first.dueDate)}` : "";
  return `${formatWon(first.totalAmount)}${more}${due}`;
}

/** 메일 후보 금액 − 가장 가까운 정산서 금액. 정산서가 없으면 null. */
function statementDelta(totalAmount: number | null, month: InvoiceMonth): number | null {
  if (totalAmount === null || month.expected.length === 0) return null;
  return month.expected
    .map((item) => totalAmount - item.totalAmount)
    .reduce((best, delta) => (Math.abs(delta) < Math.abs(best) ? delta : best));
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

/** 달별 줄 하나 — 줄 전체가 마우스 올림 트리거다(풀이 + 세부). */
function MonthRow({ month, awaitingHint }: { month: InvoiceMonth; awaitingHint: string | null }) {
  const [open, setOpen] = useState(false);
  const openOnTouch = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") setOpen(true);
  };
  // 메일함 확인 전에는 「미발견」·「조회불가」를 단정하지 않는다 — 판정이 메일에 기대는 상태는 「—」.
  const awaitingScan =
    awaitingHint !== null && (month.state === "NOT_FOUND" || month.state === "OUT_OF_SCAN");
  // 기록은 됐는데 합계가 전액과 어긋난 달(R0) — 작성일은 그대로 두고 낱말·색·풀이만 어긋남 상태 것을 쓴다.
  // 칸: 「9/30 · 오류 가능성」(점은 caution). 끝난 달 수(n/m)에는 그대로 센다 — 머리글이 「확인 필요」를 따로 보인다.
  const mismatch = month.recorded.length > 0 ? month.mismatch : null;
  const label = awaitingScan ? null : INVOICE_MONTH_LABEL[mismatch ?? month.state];
  const tone = awaitingScan ? "none" : INVOICE_MONTH_TONE[mismatch ?? month.state];
  // 수정세금계산서가 따라온 기록 달이 어긋남까지 겹치면(리뷰 2026-10-15 #5) 작성일과 어긋남 낱말을 함께 보이고,
  // 「수정됨」은 풀이에 덧붙인다 — 한쪽 신호가 다른 쪽을 덮어 작성일까지 사라지지 않게.
  const amendedAndMismatched = month.state === "AMENDED" && mismatch !== null;
  const hint = awaitingScan
    ? awaitingHint
    : amendedAndMismatched
      ? `${INVOICE_MONTH_HINT[mismatch ?? month.state]} ${INVOICE_MONTH_HINT.AMENDED}`
      : INVOICE_MONTH_HINT[mismatch ?? month.state];
  const lastRecorded = month.recorded.at(-1) ?? null;
  const showsDate = month.state === "RECORDED" || amendedAndMismatched;
  const shown = showsDate
    ? `${formatMonthDay(lastRecorded?.writtenAt ?? null)}${mismatch ? ` · ${label}` : ""}`
    : label ?? INVOICE_MONTH_EMPTY_MARK;
  const detail = lastRecorded ?? null;
  // 어긋남 상태도 메일 후보 한 장이 근거다 — 금액을 같은 자리에서 보인다.
  const candidate =
    month.state === "PENDING" || month.state === "MINOR_MISMATCH" || month.state === "OVER_EXPECTED" || month.state === "POSSIBLE_SPLIT"
      ? month.candidates[0]
      : null;

  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onPointerDown={openOnTouch}
          data-testid={`invoice-month-${month.yearMonth}`}
          className="grid h-6 w-full grid-cols-[44px_minmax(0,1fr)] items-center rounded-md px-1 text-left text-xs hover:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          <span className="text-slate-700">{formatInvoiceMonth(month.yearMonth)}</span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 truncate",
              showsDate ? "tabular-nums text-foreground" : label ? "text-slate-700" : "text-muted-foreground",
            )}
          >
            {tone !== "none" ? <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} aria-hidden="true" /> : null}
            <span className="underline decoration-slate-300 decoration-dotted underline-offset-4">{shown}</span>
            {month.recorded.length > 1 ? <span className="text-muted-foreground">외 {month.recorded.length - 1}장</span> : null}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 space-y-1.5 p-3">
        <p className="text-xs text-slate-600">{hint}</p>
        {month.reviewedMismatch ? (
          <p className="text-xs text-muted-foreground">금액 차이({INVOICE_MONTH_LABEL[month.reviewedMismatch]})는 확인했습니다.</p>
        ) : null}
        {month.notes.map((note) => (
          <p key={note} className="text-xs font-medium text-foreground">
            {INVOICE_MONTH_NOTE_HINT[note]}
          </p>
        ))}
        {detail ? (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <DetailRow label="작성일" value={detail.writtenAt ?? "—"} />
            <DetailRow label="공급가액" value={formatWon(detail.supplyAmount)} />
            <DetailRow label="세액" value={formatWon(detail.taxAmount)} />
            <DetailRow label="합계" value={formatWon(detail.totalAmount)} />
            {detail.itemName ? <DetailRow label="품목명" value={detail.itemName} /> : null}
            {detail.approvalNo ? <DetailRow label="승인번호" value={detail.approvalNo} /> : null}
            <DetailRow label="출처" value={SOURCE_LABEL[detail.source]} />
          </div>
        ) : candidate ? (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <DetailRow label="작성일" value={candidate.writtenDate ?? "—"} />
            <DetailRow label="합계" value={formatWon(candidate.totalAmount)} />
            {candidate.itemName ? <DetailRow label="품목명" value={candidate.itemName} /> : null}
            {month.candidates.length > 1 ? <DetailRow label="후보" value={`${month.candidates.length}장`} /> : null}
          </div>
        ) : null}
        {formatExpected(month) ? (
          <div className="border-t border-border/60 pt-1.5">
            <DetailRow label="정산서 금액" value={formatExpected(month)} />
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}

async function postInvoice(campaignId: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`/api/campaigns/${campaignId}/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    toast.error(payload?.error ?? "저장하지 못했습니다.");
    return false;
  }
  return true;
}

/** 메일 후보 한 장 — 확인 창 안. 같은 달 같은 브랜드 계산서가 여러 장이 정상이라 고를 근거를 다 보인다. */
function CandidateCard({
  mail,
  busy,
  onConfirm,
  onDismiss,
  confirmLabel = "확인",
  statementDelta = null,
}: {
  mail: InvoiceMailSummary;
  busy: boolean;
  onConfirm: () => void;
  /** 없으면 「이 메일이 아님」 버튼을 그리지 않는다(수정세금계산서 카드). */
  onDismiss?: () => void;
  confirmLabel?: string;
  /**
   * 메일 금액 − 정산서 금액(가장 가까운 것). null = 그 달 정산서 없음. 같은 달 같은 브랜드 계산서가
   * 여러 장일 때 고를 근거다(T-242) — 맞으면 회색 한마디, 다르면 차이를 글자로 진하게(색 추가 없음).
   */
  statementDelta?: number | null;
}) {
  const matches = statementDelta !== null && Math.abs(statementDelta) <= INVOICE_AMOUNT_TOLERANCE_WON;
  return (
    <div className="space-y-1 rounded-lg border border-border/70 p-2.5">
      <DetailRow label="작성일" value={mail.writtenDate ?? "—"} />
      <DetailRow label="공급가액" value={formatWon(mail.supplyAmount)} />
      <DetailRow label="세액" value={formatWon(mail.taxAmount)} />
      <DetailRow
        label="합계"
        value={
          <>
            {formatWon(mail.totalAmount)}
            {statementDelta === null ? null : matches ? (
              <span className="ml-1.5 text-muted-foreground">정산서 금액과 같음</span>
            ) : (
              <span className="ml-1.5 font-medium text-foreground">
                정산서보다 {Math.abs(statementDelta).toLocaleString("ko-KR")}원 {statementDelta > 0 ? "많음" : "적음"}
              </span>
            )}
          </>
        }
      />
      <DetailRow label="품목명" value={mail.itemName ?? "—"} />
      <DetailRow label="메일" value={mail.receivedAt ? `${toKstYmd(new Date(mail.receivedAt))} 받음` : "—"} />
      {mail.issueId ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">승인번호</summary>
          <p className="mt-1 tabular-nums">{mail.issueId}</p>
        </details>
      ) : null}
      <div className="flex justify-end gap-2 pt-1">
        {onDismiss ? (
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="h-7 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            이 메일이 아님
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || !mail.issueId || !mail.writtenDate}
          onClick={onConfirm}
          className="h-7 rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function ManualForm({
  busy,
  onSubmit,
  prefill,
}: {
  busy: boolean;
  onSubmit: (input: {
    writtenDate: string;
    totalAmount: number | null;
    approvalNo: string | null;
    /** 정산서 값을 고치지 않고 그대로 기록하는가 — 나중에 직접 친 값과 가를 수 있게 메모로 남긴다 */
    fromStatement: boolean;
  }) => void;
  /** 정산서가 그 달 계산서 하나를 예고했으면 작성일·합계를 미리 채운다(T-242) — 오너가 고칠 수 있다. */
  prefill?: { writtenDate: string; totalAmount: number } | null;
}) {
  const [writtenDate, setWrittenDate] = useState(prefill?.writtenDate ?? "");
  const [total, setTotal] = useState(prefill ? String(prefill.totalAmount) : "");
  const [approvalNo, setApprovalNo] = useState("");
  // 정산서가 폼을 연 뒤에 도착해도 **비어 있을 때만** 채운다 — 오너가 친 값은 건드리지 않는다.
  const prefillDate = prefill?.writtenDate ?? null;
  const prefillTotal = prefill?.totalAmount ?? null;
  useEffect(() => {
    if (prefillDate === null || prefillTotal === null) return;
    setWrittenDate((current) => current || prefillDate);
    setTotal((current) => current || String(prefillTotal));
  }, [prefillDate, prefillTotal]);
  const amount = total.trim() === "" ? null : Number(total.replace(/[^\d-]/g, ""));
  const fromStatement = prefill != null && writtenDate === prefill.writtenDate && amount === prefill.totalAmount;
  // 정산서가 예고한 작성일(월말)이 아직 오지 않았을 수 있다 — 발행 전 값을 「기록됨」으로 만들지 않는다.
  const isFuture = writtenDate !== "" && writtenDate > toKstYmd(new Date());
  return (
    <form
      className="grid grid-cols-3 gap-2 rounded-lg border border-dashed border-border p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!writtenDate || isFuture) return;
        onSubmit({
          writtenDate,
          totalAmount: amount !== null && Number.isFinite(amount) ? amount : null,
          approvalNo: approvalNo.trim() || null,
          fromStatement,
        });
      }}
    >
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        작성일
        <input type="date" required value={writtenDate} onChange={(e) => setWrittenDate(e.target.value)} className="h-7 w-full min-w-0 rounded-md border border-border px-1.5 text-xs text-foreground" />
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        합계(원)
        <input inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value)} className="h-7 w-full min-w-0 rounded-md border border-border px-1.5 text-right text-xs tabular-nums text-foreground" />
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        승인번호(선택)
        <input value={approvalNo} onChange={(e) => setApprovalNo(e.target.value)} className="h-7 w-full min-w-0 rounded-md border border-border px-1.5 text-xs tabular-nums text-foreground" />
      </label>
      <div className="col-span-3 flex items-center justify-end gap-2">
        {isFuture ? (
          <span className="mr-auto text-[10px] text-muted-foreground">작성일이 아직 오지 않았습니다.</span>
        ) : fromStatement ? (
          <span className="mr-auto text-[10px] text-muted-foreground">정산서 값입니다. 실제 계산서와 다르면 고쳐 주세요.</span>
        ) : null}
        <button type="submit" disabled={busy || !writtenDate || isFuture} className="h-7 rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          기록
        </button>
      </div>
    </form>
  );
}

function MonthSection({
  month,
  busy,
  run,
}: {
  month: InvoiceMonth;
  busy: boolean;
  run: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const confirmBody = (mail: InvoiceMailSummary) => ({
    action: "confirm",
    issueId: mail.issueId,
    writtenDate: mail.writtenDate,
    supplyAmount: mail.supplyAmount,
    taxAmount: mail.taxAmount,
    totalAmount: mail.totalAmount,
    itemName: mail.itemName,
    mailReceivedAt: mail.receivedAt,
  });
  const dismissBody = (mail: InvoiceMailSummary) => ({ action: "dismiss", issueId: mail.issueId, writtenDate: mail.writtenDate });
  const label = INVOICE_MONTH_LABEL[month.state];
  const canAddManually = month.recorded.length === 0 && !month.waived;

  return (
    <section className="space-y-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0" aria-label={`${formatInvoiceMonth(month.yearMonth)}분`}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{formatInvoiceMonth(month.yearMonth)}분</h4>
        <span className="text-xs text-muted-foreground">
          {label ?? (month.state === "RECORDED" ? "기록됨" : INVOICE_MONTH_EMPTY_MARK)}
          {month.recorded.length > 0 && month.mismatch ? ` · ${INVOICE_MONTH_LABEL[month.mismatch]}` : ""}
        </span>
      </div>
      {month.recorded.length > 0 && month.mismatch ? (
        <p className="text-xs text-slate-600">{INVOICE_MONTH_HINT[month.mismatch]}</p>
      ) : null}
      {formatExpected(month) ? (
        <p className="text-xs text-muted-foreground">정산서 금액 {formatExpected(month)}</p>
      ) : null}
      {month.recorded.map((row: CampaignInvoiceRow) => (
        <div key={row.id} className="space-y-1 rounded-lg bg-slate-50 p-2.5">
          <DetailRow label="작성일" value={row.writtenAt ?? "—"} />
          <DetailRow label="합계" value={formatWon(row.totalAmount)} />
          {row.itemName ? <DetailRow label="품목명" value={row.itemName} /> : null}
          <div className="flex justify-end pt-1">
            <button type="button" disabled={busy} onClick={() => void run({ action: "revert", rowId: row.id })} className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-white disabled:opacity-50">
              기록 취소
            </button>
          </div>
        </div>
      ))}
      {month.amendments.map((mail) => (
        <CandidateCard
          key={mail.issueId ?? mail.writtenDate}
          mail={mail}
          busy={busy}
          confirmLabel="확인함"
          // 수정세금계산서는 원본을 바꾸지 않고 「확인했다」만 남긴다 — 금액이 음수(취소분)일 수 있어
          // 기록으로 더하지 않는다(receipt-match 의 CORRECTIVE_DOCUMENT 주석). 버튼은 하나다.
          onConfirm={() => void run(dismissBody(mail))}
        />
      ))}
      {month.notes.map((note) => (
        <p key={note} className="text-xs font-medium text-foreground">
          {INVOICE_MONTH_NOTE_HINT[note]}
        </p>
      ))}
      {month.candidates.length > 0 && !month.recorded.length && !month.waived && month.state !== "COVERED"
        ? // 정산서 금액과 맞는 후보를 위로 — 첫 카드만 보고 확인해도 덜 틀리게(순서 외에는 그대로).
          [...month.candidates]
            .sort(
              (a, b) =>
                Number(matchesExpectedAmount(b.totalAmount, month.expected)) -
                Number(matchesExpectedAmount(a.totalAmount, month.expected)),
            )
            .map((mail) => (
            <CandidateCard
              key={mail.issueId ?? mail.writtenDate}
              mail={mail}
              busy={busy}
              statementDelta={statementDelta(mail.totalAmount, month)}
              onConfirm={() => void run(confirmBody(mail))}
              onDismiss={() => void run(dismissBody(mail))}
            />
          ))
        : null}
      {month.waived ? (
        <div className="flex justify-end">
          <button type="button" disabled={busy} onClick={() => void run({ action: "revert", rowId: month.waived?.id })} className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-slate-50 disabled:opacity-50">
            「없음」 취소
          </button>
        </div>
      ) : null}
      {canAddManually ? (
        <div className="space-y-2">
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setManualOpen((v) => !v)}>
              직접 입력
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-primary underline underline-offset-2 disabled:opacity-50"
              onClick={() => void run({ action: "waive", yearMonth: month.yearMonth, note: null })}
            >
              이 달은 계산서 없음
            </button>
          </div>
          {manualOpen ? (
            <ManualForm
              busy={busy}
              prefill={
                month.expected.length === 1
                  ? { writtenDate: month.expected[0].writtenDate, totalAmount: month.expected[0].totalAmount }
                  : null
              }
              onSubmit={({ fromStatement, ...input }) =>
                void run({ action: "manual", note: fromStatement ? "정산서 값 그대로 입력" : null, ...input }).then((ok) => {
                  // 실패하면 입력을 지우지 않는다 — 오너가 다시 칠 필요가 없게.
                  if (ok) setManualOpen(false);
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 칸과 세무 보드가 공유하는 계산서 상태 — 조회·메일 대조·쓰기(T-244: 두 표면이 같은 창을 쓴다). */
function useCampaignInvoices({
  campaignId,
  scan,
  onRequestScan,
  onChanged,
}: {
  campaignId: string;
  scan: ReceiptScanApiResponse | null;
  onRequestScan: () => Promise<void> | void;
  onChanged: () => Promise<void> | void;
}) {
  const [view, setView] = useState<CampaignInvoiceView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 이 칸이 메일함 확인을 시작했는가 — 시작 전에는 지난 달을 「미발견」으로 단정하지 않는다. */
  const [scanAttempted, setScanAttempted] = useState(false);
  /** 판정 기준 시각 — 그리는 도중 시계를 읽지 않도록 칸이 열릴 때 한 번 고정한다. */
  const [now] = useState(() => new Date());
  /** 정산서 메일(T-242) — 메일함 확인과 함께 한 번 읽는다. 실패해도 계산서 기록은 그대로 된다. */
  const [statements, setStatements] = useState<StatementMailSummary[] | null>(null);
  const [statementsFailed, setStatementsFailed] = useState(false);
  const [statementsLoading, setStatementsLoading] = useState(false);

  const loadStatements = useCallback(async () => {
    setStatementsLoading(true);
    try {
      const res = await fetch("/api/settlement/brand-statements");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { statements: StatementMailSummary[] };
      setStatements(data.statements);
      setStatementsFailed(false);
    } catch (error) {
      // 삼키지 않는다(P0) — 창 설명에 「정산서 확인 실패」로 드러낸다.
      console.warn("[campaign-invoice-slot] 정산서 메일 조회 실패", error);
      setStatementsFailed(true);
    } finally {
      setStatementsLoading(false);
    }
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/invoices`);
      if (!res.ok) throw new Error(String(res.status));
      setView((await res.json()) as CampaignInvoiceView);
      setLoadFailed(false);
      return true;
    } catch (error) {
      // 삼키지 않는다(P0). 이미 그린 달별 칸이 있으면 그대로 두고 알린다 — 옛 단일 날짜 칸으로
      // 떨어지면 오너가 그 칸에 날짜를 넣어 달별 판정을 우회할 수 있다(코드 리뷰 2026-10-08).
      console.warn("[campaign-invoice-slot] 계산서 조회 실패", error);
      setLoadFailed(true);
      return false;
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applicable: ApplicableView | null = view && view.applicable && !view.legacyMode ? view : null;

  const requestScan = useCallback(() => {
    setScanAttempted(true);
    void onRequestScan();
  }, [onRequestScan]);

  // 월정산 칸에 **비어 있는 달이 있을 때만** 정산서를 한 번 읽는다(메일함 스캔과 별개 — 전체보관함을
  // 훑는 비싼 조회라 다 끝난 캠페인에서는 돌리지 않는다). 실패는 창 설명에 드러난다. ref 로 막는 이유:
  // 개발 모드에서 효과가 두 번 돌아도 한 번만 부르게(상태 갱신은 그 사이에 반영되지 않는다).
  const statementsRequested = useRef(false);
  const hasOpenMonth = useMemo(() => {
    if (!applicable) return false;
    return summarizeInvoiceRows({
      periodStart: new Date(applicable.periodStart),
      periodEnd: new Date(applicable.periodEnd),
      rows: applicable.rows,
      expectedTotalAmount: applicable.expectedTotalAmount,
    }).openMonths.length > 0;
  }, [applicable]);
  useEffect(() => {
    if (!hasOpenMonth || statementsRequested.current) return;
    statementsRequested.current = true;
    void loadStatements();
  }, [hasOpenMonth, loadStatements]);

  const months = useMemo(() => {
    if (!applicable) return [];
    const mails = (scan?.results ?? [])
      .map((row) => row.invoice ?? null)
      .filter((mail): mail is InvoiceMailSummary => mail !== null);
    const { candidatesByMonth, amendmentsByMonth } = findInvoiceCandidates({
      mails,
      direction: applicable.direction,
      ourBusinessNumber: SUPPLIER.businessNumber,
      counterpartBusinessNumber: applicable.counterpartBusinessNumber,
      excludedIssueIds: new Set(applicable.excludedIssueIds),
    });
    const scanSinceYmd = scan
      ? toKstYmd(new Date(now.getTime() - scan.scan.sinceDays * 24 * 60 * 60 * 1000))
      : null;
    const expectationsByMonth = collectStatementExpectations({
      statements: statements ?? [],
      direction: applicable.direction,
      labels: applicable.sellerLabels,
      counterpartLabel: applicable.counterpartLabel,
    });
    return deriveInvoiceMonths({
      periodStart: new Date(applicable.periodStart),
      periodEnd: new Date(applicable.periodEnd),
      rows: applicable.rows,
      candidatesByMonth,
      amendmentsByMonth,
      scanSinceYmd,
      today: now,
      expectationsByMonth,
      expectedTotalAmount: applicable.expectedTotalAmount,
      expectedFromManual: applicable.expectedFromManual,
      reviewAcks: applicable.reviewAcks,
    });
  }, [applicable, scan, now, statements]);

  // 단위의 「확인 필요」 — 달 줄과 같은 판정(`resolveInvoiceReview`)이다. 창의 「확인함」이 이 지문을 보낸다.
  const review = useMemo(() => {
    if (!applicable) return null;
    const { mismatch, acknowledged } = resolveInvoiceReview({
      periodMonths: listYearMonths(new Date(applicable.periodStart), new Date(applicable.periodEnd)),
      rows: applicable.rows.filter((row) => row.status !== "DISMISSED"),
      expectedTotalAmount: applicable.expectedTotalAmount,
      reviewAcks: applicable.reviewAcks,
    });
    if (!mismatch) return null;
    // 확인한 적은 있는데 지문이 다르다 = 그 뒤 금액이 바뀌었다(다시 뜬 이유를 한 줄로 알린다).
    return { mismatch, acknowledged, staleAck: !acknowledged && applicable.reviewAcks.length > 0 };
  }, [applicable]);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      try {
        const ok = await postInvoice(campaignId, body);
        if (!ok) return false;
        const [reloaded] = await Promise.all([load(), onChanged()]);
        if (!reloaded) toast.warning("저장했지만 계산서 칸을 다시 읽지 못했습니다. 새로고침해 주세요.");
        return true;
      } finally {
        setBusy(false);
      }
    },
    [busy, campaignId, load, onChanged],
  );

  return { view, loadFailed, applicable, months, review, busy, run, requestScan, scanAttempted, statementsFailed, statementsLoading, hasOpenMonth };
}

type UnitReview = { mismatch: RecordedMismatch; acknowledged: InvoiceReviewAck | null; staleAck: boolean };

function formatAckWhen(ack: InvoiceReviewAck): string {
  return ack.acknowledgedAt ? toKstYmd(new Date(ack.acknowledgedAt)) : INVOICE_MONTH_EMPTY_MARK;
}

function formatSignedWon(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toLocaleString("ko-KR")}원`;
}

/**
 * 창 맨 위의 금액 차이 블록 — 「확인 필요」면 「확인함」, 확인했으면 조용한 「확인됨」과 「확인 취소」.
 * 확인은 이 차이(지문)에만 묶인다 — 금액이 바뀌면 블록이 다시 「확인 필요」로 돌아온다(오너 승인 2026-10-15).
 */
function ReviewBlock({
  review,
  busy,
  run,
}: {
  review: UnitReview;
  busy: boolean;
  run: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { mismatch, acknowledged } = review;
  return (
    <section aria-label="금액 차이" className="space-y-1.5 rounded-lg border border-border/70 p-2.5" data-testid="invoice-review-block">
      <div className="flex items-center justify-between gap-2">
        {acknowledged ? (
          <span className="text-xs text-muted-foreground">
            확인됨 · {acknowledged.acknowledgedBy ?? INVOICE_MONTH_EMPTY_MARK} · {formatAckWhen(acknowledged)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <span className="size-1.5 rounded-full bg-status-caution" aria-hidden="true" />
            확인 필요
          </span>
        )}
        {acknowledged ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ action: "revokeReviewAck" })}
            className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-slate-50 disabled:opacity-50"
          >
            확인 취소
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ action: "acknowledgeReview", fingerprint: mismatch.fingerprint })}
            className="h-7 rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            확인함
          </button>
        )}
      </div>
      <p className="text-xs text-slate-600">{AUTO_RECORD_REVIEW_LABEL[mismatch.kind]}</p>
      <DetailRow label="기록 합계" value={formatWon(mismatch.recordedTotal)} />
      <DetailRow label="캠페인 전액" value={formatWon(mismatch.expectedTotal)} />
      <DetailRow label="차이" value={formatSignedWon(mismatch.delta)} />
      {review.staleAck ? <p className="text-xs text-muted-foreground">확인한 뒤 금액이 바뀌어 다시 확인이 필요합니다.</p> : null}
    </section>
  );
}

/** 머리글의 조용한 「확인됨」 — 누가·언제는 마우스를 올리면(키보드 포커스·터치 포함) 뜨는 작은 창에. */
function ReviewAckMarker({ ack, kind }: { ack: InvoiceReviewAck; kind: RecordedMismatch["kind"] }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onPointerDown={(event) => {
            if (event.pointerType === "touch") setOpen(true);
          }}
          data-testid="campaign-invoice-review-ack"
          className="rounded-sm font-normal text-muted-foreground underline decoration-slate-300 decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          확인됨
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 space-y-1.5 p-3">
        <p className="text-xs text-slate-600">
          금액 차이({AUTO_RECORD_REVIEW_LABEL[kind]})를 확인했습니다. 금액이 바뀌면 다시 확인 필요로 돌아옵니다.
        </p>
        <div className="space-y-1 border-t border-border/60 pt-1.5">
          <DetailRow label="확인" value={ack.acknowledgedBy ?? INVOICE_MONTH_EMPTY_MARK} />
          <DetailRow label="날짜" value={formatAckWhen(ack)} />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** 달별 확인·직접 입력·「없음」·취소 창 — 캠페인 상세 칸과 세무 보드가 같은 창을 연다. */
function InvoiceMonthsDialog({
  open,
  onOpenChange,
  title,
  applicable,
  months,
  busy,
  scanLoading,
  statementsFailed,
  statementsLoading,
  run,
  review,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  applicable: ApplicableView;
  months: InvoiceMonth[];
  /** 단위의 금액 차이(`resolveInvoiceReview`) — 없으면 블록을 그리지 않는다 */
  review: UnitReview | null;
  busy: boolean;
  scanLoading: boolean;
  statementsFailed: boolean;
  statementsLoading: boolean;
  run: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" style={{ scrollbarGutter: "stable" }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {applicable.counterpartLabel}
            {applicable.memberCount > 1 ? ` · 그룹 ${applicable.memberCount}개 캠페인 합산 1장` : ""}
            {scanLoading ? " · 메일함 확인 중" : ""}
            {statementsLoading ? " · 정산서 확인 중" : statementsFailed ? " · 정산서 메일 확인 실패" : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {review ? <ReviewBlock review={review} busy={busy || scanLoading} run={run} /> : null}
          {months.map((month) => (
            <MonthSection key={month.yearMonth} month={month} busy={busy || scanLoading} run={run} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 세무 보드의 월정산 공급사 행 「조회」가 여는 창(T-244). 보드는 날짜 한 칸으로 「완료」를 찍지 않는다 —
 * 캠페인 상세 계산서 칸과 **같은 창**에서 달별로 기록하고, 기록이 바뀌면 보드를 다시 읽는다.
 * 창을 열 때 메일함을 아직 안 봤으면 한 번 본다(보드의 「메일함 확인」과 같은 스캔).
 */
export function CampaignInvoiceDialog({
  campaignId,
  title,
  onOpenChange,
  scan,
  scanLoading,
  onRequestScan,
  onChanged,
}: {
  campaignId: string;
  title: string;
  onOpenChange: (open: boolean) => void;
  scan: ReceiptScanApiResponse | null;
  scanLoading: boolean;
  onRequestScan: () => Promise<void> | void;
  onChanged: () => Promise<void> | void;
}) {
  const { view, loadFailed, applicable, months, review, busy, run, requestScan, scanAttempted, statementsFailed, statementsLoading } = useCampaignInvoices({
    campaignId,
    scan,
    onRequestScan,
    onChanged,
  });

  useEffect(() => {
    if (!applicable || scan || scanLoading || scanAttempted) return;
    requestScan();
  }, [applicable, scan, scanLoading, scanAttempted, requestScan]);

  // 한 번이라도 달별 창을 그렸는가 — 그 뒤의 재조회 실패·모드 변화는 「처음부터 못 연 것」과 다르다.
  const [wasApplicable, setWasApplicable] = useState(false);
  useEffect(() => {
    if (applicable) setWasApplicable(true);
  }, [applicable]);

  // 처음 읽기에 실패했거나 대상이 아니면(그새 스위치가 꺼짐·레거시 모드) 이유를 알리고 닫는다 —
  // 조용히 빈 창을 띄우지 않는다. 열린 뒤 저장으로 레거시 모드가 되면(다른 경로의 날짜가 남은 채
  // 마지막 기록을 취소) 조용히 닫는다 — 보드는 `onChanged` 로 다시 읽어 그 행을 정리한다. 저장 뒤
  // 재조회만 실패한 경우는 `run` 이 이미 경고했고 마지막 화면을 그대로 둔다(코드 리뷰 2026-10-09).
  const failedToOpen = !wasApplicable && (loadFailed || (view !== null && !applicable));
  const leftMonthlyMode = wasApplicable && view !== null && !applicable;
  useEffect(() => {
    if (failedToOpen) {
      toast.error(
        loadFailed
          ? "계산서 기록을 읽지 못했습니다. 다시 시도해 주세요."
          : "이 캠페인은 달별 계산서 대상이 아닙니다. 캠페인 상세에서 확인해 주세요.",
      );
      onOpenChange(false);
    } else if (leftMonthlyMode) {
      onOpenChange(false);
    }
  }, [failedToOpen, leftMonthlyMode, loadFailed, onOpenChange]);

  if (!applicable) return null;
  return (
    <InvoiceMonthsDialog
      open
      onOpenChange={onOpenChange}
      title={title}
      applicable={applicable}
      months={months}
      review={review}
      busy={busy}
      scanLoading={scanLoading}
      statementsFailed={statementsFailed}
      statementsLoading={statementsLoading}
      run={run}
    />
  );
}

export function CampaignInvoiceSlot({
  campaignId,
  title,
  scan,
  scanLoading,
  autoLookup,
  onRequestScan,
  onChanged,
  legacyFallback,
  attachment,
}: {
  campaignId: string;
  /** 칸 제목 — 판정표의 슬롯 제목 그대로(예: 「공급사 계산서 발행」) */
  title: string;
  scan: ReceiptScanApiResponse | null;
  scanLoading: boolean;
  /** 열 때 메일함을 자동으로 볼 캠페인인가 — 정산 단계 · 판매 종료 후 60일 이내(`isInvoiceLookupTarget`). */
  autoLookup: boolean;
  /** 메일함 조회(읽기 전용 IMAP 스캔) — 부모가 결과를 소유한다(수취 칸과 같은 스캔을 재사용). */
  onRequestScan: () => Promise<void> | void;
  /** 기록이 바뀐 뒤 캠페인 행을 다시 읽는다(레거시 날짜가 같이 바뀔 수 있다). */
  onChanged: () => Promise<void> | void;
  /** 월정산이 아니거나 레거시 모드면 지금까지의 단일 날짜 칸을 그대로 그린다. */
  legacyFallback: ReactNode;
  /** 증빙 첨부 버튼(기존 칸과 같은 것) */
  attachment: ReactNode;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { view, loadFailed, applicable, months, review, busy, run, requestScan, scanAttempted, statementsFailed, statementsLoading, hasOpenMonth } = useCampaignInvoices({
    campaignId,
    scan,
    onRequestScan,
    onChanged,
  });

  // 열 때 메일함을 한 번 본다 — 확인 전에는 지난 달을 「미발견」으로 단정할 수 없어서다. 단 자동 조회 대상
  // (정산 단계 · 판매 종료 후 60일 이내)이고 아직 빈 달이 있을 때만 — 다 끝난 캠페인에서 메일함 전체를 다시
  // 훑지 않는다(오너 확정 2026-10-21). 대상이 아니어도 「조회」 버튼은 그대로 쓸 수 있다.
  const autoScan = autoLookup && hasOpenMonth;
  useEffect(() => {
    if (!autoScan || scan || scanLoading || scanAttempted) return;
    requestScan();
  }, [autoScan, scan, scanLoading, scanAttempted, requestScan]);

  // 처음 읽기 전에는 옛 단일 날짜 칸을 잠깐이라도 보이지 않는다(그 칸에 날짜를 넣으면 달별 판정을
  // 우회한다). 읽기에 실패했을 때만 옛 칸으로 돌아간다 — 그 실패는 위 load 가 콘솔에 남긴다.
  if (view === null) {
    if (loadFailed) return <>{legacyFallback}</>;
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2" aria-busy="true">
        <span className="mt-1 block text-xs font-semibold text-slate-700">{title}</span>
        <span className="block text-xs text-muted-foreground">{INVOICE_MONTH_EMPTY_MARK}</span>
      </div>
    );
  }
  if (!applicable) return <>{legacyFallback}</>;

  const done = months.filter((m) => isInvoiceMonthDone(m.state)).length;
  // 달은 다 끝났는데 기록한 합계가 전액과 어긋난다(R0) — n/m 이 깨끗한 완료로 읽히지 않게 머리글에 함께 보인다.
  const mismatch = months.find((m) => m.recorded.length > 0 && m.mismatch)?.mismatch ?? null;
  const scanning = scanLoading || (autoScan && !scan && !scanAttempted);
  // 메일함을 안 본 달은 「미발견」·「조회불가」로 단정하지 않고 「—」로 둔다 — 풀이만 조회 중인지·자동 조회 밖인지로 가른다.
  const awaitingHint = scanning ? SCANNING_HINT : scan ? null : scanAttempted ? SCAN_FAILED_HINT : LOOKUP_IDLE_HINT;

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2" data-testid="campaign-invoice-slot">
      <div className="flex items-start justify-between gap-2">
        <span className="mt-1 flex items-baseline gap-1.5 text-xs font-semibold text-slate-700">
          {title}
          <span className="font-normal tabular-nums text-muted-foreground">
            {done}/{months.length}
          </span>
          {mismatch ? (
            <span
              className="inline-flex items-center gap-1 font-normal text-slate-700"
              title={INVOICE_MONTH_HINT[mismatch]}
              data-testid="campaign-invoice-review"
            >
              <span className="size-1.5 rounded-full bg-status-caution" aria-hidden="true" />
              확인 필요
            </span>
          ) : review?.acknowledged ? (
            // 오너가 이 차이를 확인했다 — 색 없이 낱말 하나만(P8 「정상 상태는 안 튄다」), 누가·언제는 풀이 창에.
            <ReviewAckMarker ack={review.acknowledged} kind={review.mismatch.kind} />
          ) : null}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={scanLoading}
            onClick={() => {
              setDialogOpen(true);
              requestScan();
            }}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-soft-sm transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-50"
          >
            {scanLoading ? "조회 중" : "조회"}
          </button>
          {attachment}
        </div>
      </div>
      <div className="space-y-0.5">
        <div className="grid grid-cols-[44px_minmax(0,1fr)] px-1 text-[10px] text-muted-foreground">
          <span>월</span>
          <span>작성일</span>
        </div>
        {months.map((month) => (
          <MonthRow key={month.yearMonth} month={month} awaitingHint={awaitingHint} />
        ))}
      </div>
      <InvoiceMonthsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={title}
        applicable={applicable}
        months={months}
        review={review}
        busy={busy}
        scanLoading={scanLoading}
        statementsFailed={statementsFailed}
        statementsLoading={statementsLoading}
        run={run}
      />
    </div>
  );
}
