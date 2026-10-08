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
import { useCallback, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";
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
  INVOICE_MONTH_EMPTY_MARK,
  INVOICE_MONTH_HINT,
  INVOICE_MONTH_LABEL,
  INVOICE_MONTH_TONE,
  deriveInvoiceMonths,
  findInvoiceCandidates,
  formatInvoiceMonth,
  type CampaignInvoiceRow,
  type CampaignInvoiceView,
  type InvoiceMailSummary,
  type InvoiceMonth,
} from "@/lib/campaign-invoices";
import type { ReceiptScanApiResponse } from "@/lib/tax-invoice-mail/board-evidence";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { toKstYmd } from "@/lib/date-utils";

type ApplicableView = Extract<CampaignInvoiceView, { applicable: true }>;

const DOT_CLASS: Record<"none" | "info" | "caution" | "slate", string> = {
  none: "",
  info: "bg-status-info",
  caution: "bg-status-caution",
  slate: "bg-slate-400",
};

const SCANNING_HINT = "메일함을 확인하고 있습니다.";

function formatWon(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ko-KR")}원`;
}

function formatMonthDay(ymd: string | null): string {
  if (!ymd) return INVOICE_MONTH_EMPTY_MARK;
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
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
function MonthRow({ month, scanning }: { month: InvoiceMonth; scanning: boolean }) {
  const [open, setOpen] = useState(false);
  const openOnTouch = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") setOpen(true);
  };
  // 메일함 확인 전에는 「미발견」·「조회불가」를 단정하지 않는다 — 판정이 메일에 기대는 상태는 「—」.
  const awaitingScan =
    scanning && (month.state === "NOT_FOUND" || month.state === "OUT_OF_SCAN");
  const label = awaitingScan ? null : INVOICE_MONTH_LABEL[month.state];
  const tone = awaitingScan ? "none" : INVOICE_MONTH_TONE[month.state];
  const hint = awaitingScan ? SCANNING_HINT : INVOICE_MONTH_HINT[month.state];
  const lastRecorded = month.recorded.at(-1) ?? null;
  const shown = month.state === "RECORDED" ? formatMonthDay(lastRecorded?.writtenAt ?? null) : label ?? INVOICE_MONTH_EMPTY_MARK;
  const detail = lastRecorded ?? null;
  const candidate = month.state === "PENDING" ? month.candidates[0] : null;

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
              month.state === "RECORDED" ? "tabular-nums text-foreground" : label ? "text-slate-700" : "text-muted-foreground",
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
        {detail ? (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <DetailRow label="작성일" value={detail.writtenAt ?? "—"} />
            <DetailRow label="공급가액" value={formatWon(detail.supplyAmount)} />
            <DetailRow label="세액" value={formatWon(detail.taxAmount)} />
            <DetailRow label="합계" value={formatWon(detail.totalAmount)} />
            {detail.itemName ? <DetailRow label="품목명" value={detail.itemName} /> : null}
            {detail.approvalNo ? <DetailRow label="승인번호" value={detail.approvalNo} /> : null}
            <DetailRow label="출처" value={detail.source === "MAIL" ? "발급 메일" : "직접 입력"} />
          </div>
        ) : candidate ? (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <DetailRow label="작성일" value={candidate.writtenDate ?? "—"} />
            <DetailRow label="합계" value={formatWon(candidate.totalAmount)} />
            {candidate.itemName ? <DetailRow label="품목명" value={candidate.itemName} /> : null}
            {month.candidates.length > 1 ? <DetailRow label="후보" value={`${month.candidates.length}장`} /> : null}
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
}: {
  mail: InvoiceMailSummary;
  busy: boolean;
  onConfirm: () => void;
  /** 없으면 「이 메일이 아님」 버튼을 그리지 않는다(수정세금계산서 카드). */
  onDismiss?: () => void;
  confirmLabel?: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border/70 p-2.5">
      <DetailRow label="작성일" value={mail.writtenDate ?? "—"} />
      <DetailRow label="공급가액" value={formatWon(mail.supplyAmount)} />
      <DetailRow label="세액" value={formatWon(mail.taxAmount)} />
      <DetailRow label="합계" value={formatWon(mail.totalAmount)} />
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

function ManualForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { writtenDate: string; totalAmount: number | null; approvalNo: string | null }) => void }) {
  const [writtenDate, setWrittenDate] = useState("");
  const [total, setTotal] = useState("");
  const [approvalNo, setApprovalNo] = useState("");
  const amount = total.trim() === "" ? null : Number(total.replace(/[^\d-]/g, ""));
  return (
    <form
      className="grid grid-cols-3 gap-2 rounded-lg border border-dashed border-border p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!writtenDate) return;
        onSubmit({ writtenDate, totalAmount: amount !== null && Number.isFinite(amount) ? amount : null, approvalNo: approvalNo.trim() || null });
      }}
    >
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        작성일
        <input type="date" required value={writtenDate} onChange={(e) => setWrittenDate(e.target.value)} className="h-7 rounded-md border border-border px-1.5 text-xs text-foreground" />
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        합계(원)
        <input inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value)} className="h-7 rounded-md border border-border px-1.5 text-right text-xs tabular-nums text-foreground" />
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        승인번호(선택)
        <input value={approvalNo} onChange={(e) => setApprovalNo(e.target.value)} className="h-7 rounded-md border border-border px-1.5 text-xs tabular-nums text-foreground" />
      </label>
      <div className="col-span-3 flex justify-end">
        <button type="submit" disabled={busy || !writtenDate} className="h-7 rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
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
        <span className="text-xs text-muted-foreground">{label ?? (month.state === "RECORDED" ? "기록됨" : INVOICE_MONTH_EMPTY_MARK)}</span>
      </div>
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
      {month.state === "PENDING"
        ? month.candidates.map((mail) => (
            <CandidateCard
              key={mail.issueId ?? mail.writtenDate}
              mail={mail}
              busy={busy}
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
              onSubmit={(input) =>
                void run({ action: "manual", note: null, ...input }).then((ok) => {
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
    return deriveInvoiceMonths({
      periodStart: new Date(applicable.periodStart),
      periodEnd: new Date(applicable.periodEnd),
      rows: applicable.rows,
      candidatesByMonth,
      amendmentsByMonth,
      scanSinceYmd,
      today: now,
    });
  }, [applicable, scan, now]);

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

  return { view, loadFailed, applicable, months, busy, run, requestScan, scanAttempted };
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
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  applicable: ApplicableView;
  months: InvoiceMonth[];
  busy: boolean;
  scanLoading: boolean;
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
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
  const { view, loadFailed, applicable, months, busy, run, requestScan, scanAttempted } = useCampaignInvoices({
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
      busy={busy}
      scanLoading={scanLoading}
      run={run}
    />
  );
}

export function CampaignInvoiceSlot({
  campaignId,
  title,
  scan,
  scanLoading,
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
  const { view, loadFailed, applicable, months, busy, run, requestScan, scanAttempted } = useCampaignInvoices({
    campaignId,
    scan,
    onRequestScan,
    onChanged,
  });

  // 열 때 메일함을 한 번 본다 — 확인 전에는 지난 달을 「미발견」으로 단정할 수 없어서다.
  useEffect(() => {
    if (!applicable || scan || scanLoading || scanAttempted) return;
    requestScan();
  }, [applicable, scan, scanLoading, scanAttempted, requestScan]);

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

  const done = months.filter((m) => m.state === "RECORDED" || m.state === "WAIVED").length;
  const scanning = scanLoading || (!scan && !scanAttempted);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2" data-testid="campaign-invoice-slot">
      <div className="flex items-start justify-between gap-2">
        <span className="mt-1 flex items-baseline gap-1.5 text-xs font-semibold text-slate-700">
          {title}
          <span className="font-normal tabular-nums text-muted-foreground">
            {done}/{months.length}
          </span>
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
          <MonthRow key={month.yearMonth} month={month} scanning={scanning} />
        ))}
      </div>
      <InvoiceMonthsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={title}
        applicable={applicable}
        months={months}
        busy={busy}
        scanLoading={scanLoading}
        run={run}
      />
    </div>
  );
}
