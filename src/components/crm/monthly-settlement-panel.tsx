"use client";

/**
 * 캠페인 상세(정산 워크스페이스)의 「월별 정산」 패널(T-240) — 월정산 거래처 캠페인에서만 그린다.
 *
 * 무엇을 판단하게 하나: 한 회차가 월을 넘기면 브랜드 계산서·지급이 달마다 나뉜다. 오너가 줄마다
 * 내리는 결정은 「이 달 얼마를 내고 끝났나」라서 접힌 행의 주 숫자는 **지급액**, 거래액은 합계
 * 검증용 대조값으로 낮춘다(ss-ux-designer 검토 2026-10-08). 정산 완료는 모든 줄이 4/4 여야 하므로
 * 「n줄 중 m줄 완료」를 헤더에 상시 노출한다(완료가 막힌 이유를 409 오류에만 두지 않는다).
 *
 * 색(P8): 일치 = 생애주기 완료(`status-success`, 아이콘·글자만), 불일치 = 심각도(`status-urgent`).
 * 금액은 전부 무채색 — 지급액에 `money-out` 을 입히면 줄마다 반복되는 빨강이 습관화된다.
 * 체크 n/4 는 4/4 만 성공색, 나머지는 중립.
 *
 * 쓰기 SSOT 는 `/api/campaigns/[id]/monthly-settlements`(→ `monthlySettlementService`).
 * 줄을 바꾸면 서버가 캠페인 물품대금을 다시 맞추므로 캠페인 행도 다시 읽어 재무 카드에 꽂는다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, CheckCircle2, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { toKstYmd } from "@/lib/date-utils";
import type { CampaignRow } from "@/lib/crm-types";
import { refreshCampaignRows } from "@/lib/campaign-row-refresh";
import {
  clipPeriodToMonth,
  countMonthlyChecks,
  formatMonthlyLineLabel,
  isMonthlyLineComplete,
  MONTHLY_CHECKLIST_ITEMS,
  resolveMonthlyPaymentAmount,
  resolveNextMonthToAdd,
  summarizeMonthlySettlements,
  type MonthlyChecklistKey,
  type MonthlySettlementLine,
} from "@/lib/monthly-settlement";
import {
  buildMonthlyLinePatch,
  MonthlySettlementLineEditor,
  toMonthlyLineDraft,
  type MonthlyDraftField,
  type MonthlyLineDraft,
} from "./monthly-settlement-line-editor";

type MonthlySettlementView = {
  enabled: boolean;
  lines: MonthlySettlementLine[];
  orderDateReference: Record<string, { orders: number; revenue: number }>;
  campaignTransactionAmount: number | null;
};

const GRID = "grid grid-cols-[20px_minmax(0,150px)_minmax(0,1fr)_minmax(0,1fr)_88px] items-center gap-3";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : "요청을 처리하지 못했습니다.";
    throw new Error(message);
  }
  return body as T;
}

function formatShortYmd(ymd: string | null): string {
  if (!ymd) return "";
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}

function daysOverdue(dueYmd: string, todayYmd: string): number {
  const ms = Date.parse(`${todayYmd}T00:00:00Z`) - Date.parse(`${dueYmd}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function CheckTicks({ line }: { line: MonthlySettlementLine }) {
  const checks = countMonthlyChecks(line);
  const complete = checks === MONTHLY_CHECKLIST_ITEMS.length;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="sr-only">
        체크리스트 {MONTHLY_CHECKLIST_ITEMS.length}개 중 {checks}개 완료
      </span>
      <span aria-hidden="true" className="flex gap-0.5">
        {MONTHLY_CHECKLIST_ITEMS.map((item) => (
          <span
            key={item.key}
            className={cn("h-1.5 w-3", line[item.key] != null ? "bg-primary" : "bg-slate-200")}
          />
        ))}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center gap-0.5 text-xs tabular-nums",
          complete ? "text-status-success" : "text-slate-600",
        )}
      >
        {complete ? <CheckCircle2 className="size-3" /> : null}
        {checks}/{MONTHLY_CHECKLIST_ITEMS.length}
      </span>
    </div>
  );
}

function VerificationFooter({
  lines,
  campaignTransactionAmount,
}: {
  lines: MonthlySettlementLine[];
  campaignTransactionAmount: number | null;
}) {
  const summary = summarizeMonthlySettlements(lines, campaignTransactionAmount);
  const missing = lines.filter((line) => line.transactionAmount == null).length;
  const diff = summary.transactionDiff;
  // 입력 중(빈 거래액 줄)에는 빨강 대신 중립 — 줄을 막 추가할 때마다 빨강이 뜨면 습관화된다.
  const state = missing > 0 || diff == null ? "pending" : diff === 0 ? "match" : "mismatch";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "grid min-h-[56px] content-center gap-0.5 rounded-xl border px-3 py-2 text-xs",
        state === "mismatch" ? "border-status-urgent/30 bg-status-urgent-bg" : "border-slate-200 bg-slate-50",
      )}
    >
      {state === "match" ? (
        <div className="flex items-center gap-1.5 font-semibold text-slate-800">
          <CheckCircle2 className="size-3.5 text-status-success" />
          <span>거래액 합계 일치</span>
          <span className="tabular-nums">· {formatCurrency(summary.transactionTotal)}원</span>
        </div>
      ) : state === "mismatch" && diff != null ? (
        <div className="grid gap-0.5 text-status-urgent-text">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-3.5 shrink-0" />
            거래액이 맞지 않습니다 · 차이 {formatCurrency(Math.abs(diff))}원 (월별 합이 더 {diff < 0 ? "적음" : "많음"})
          </div>
          <div className="tabular-nums">
            월별 합 {formatCurrency(summary.transactionTotal)}원 · 캠페인 총 거래액 {formatCurrency(campaignTransactionAmount)}원
          </div>
        </div>
      ) : (
        <div className="text-slate-600">
          {campaignTransactionAmount == null
            ? "캠페인 총 거래액이 아직 없어 비교하지 않습니다."
            : `거래액을 입력하지 않은 줄이 ${missing}개 있어 아직 비교하지 않습니다. 합이 캠페인 총 거래액과 맞게 나눠 입력하세요.`}
        </div>
      )}
      <div className="tabular-nums text-slate-600">
        지급액 합계 {formatCurrency(summary.paymentTotal)}원
        {state === "mismatch" ? " · 이 경고는 참고용이며 정산 완료를 막지 않습니다." : ""}
      </div>
    </div>
  );
}

export function MonthlySettlementPanel({
  campaign,
  onCampaignUpdated,
}: {
  campaign: CampaignRow;
  onCampaignUpdated: (campaign: CampaignRow) => void;
}) {
  const enabled = Boolean(campaign.partnerMonthlySettlement);
  const [view, setView] = useState<MonthlySettlementView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, MonthlyLineDraft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, MonthlyDraftField | null>>({});
  const [pendingCheck, setPendingCheck] = useState<{ id: string; key: MonthlyChecklistKey } | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MonthlySettlementLine | null>(null);

  const baseUrl = `/api/campaigns/${campaign.id}/monthly-settlements`;

  const load = useCallback(async () => {
    try {
      const next = await requestJson<MonthlySettlementView>(baseUrl);
      setView(next);
      setLoadError(false);
      return next;
    } catch (error) {
      console.error("[monthly-settlement] 조회 실패:", error);
      setLoadError(true);
      return null;
    }
  }, [baseUrl]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void load().then((next) => {
      if (cancelled || !next) return;
      // 1줄이면 펼친 채로(지금과 같은 느낌), 2줄 이상이면 첫 미완료 줄만 펼친다.
      const target = next.lines.length === 1 ? next.lines[0] : next.lines.find((l) => !isMonthlyLineComplete(l));
      if (target) setExpanded((prev) => ({ [target.id]: true, ...prev }));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  /** 줄을 바꾸면 서버가 캠페인 물품대금을 다시 맞춘다 — 재무 카드가 낡지 않게 행을 다시 읽는다. */
  const refreshCampaign = useCallback(async () => {
    const failed = await refreshCampaignRows([campaign.id], onCampaignUpdated);
    if (failed > 0) toast.warning("저장은 됐지만 재무 카드 갱신에 실패했습니다. 새로고침해 주세요.");
  }, [campaign.id, onCampaignUpdated]);

  const lines = useMemo(() => view?.lines ?? [], [view]);
  const nextMonth = resolveNextMonthToAdd(
    lines,
    toKstYmd(new Date(campaign.startDate)),
    toKstYmd(new Date(campaign.endDate)),
  );

  if (!enabled) return null;

  const draftOf = (line: MonthlySettlementLine) => drafts[line.id] ?? toMonthlyLineDraft(line);
  const isDirty = (line: MonthlySettlementLine) => {
    const draft = drafts[line.id];
    if (!draft) return false;
    const base = toMonthlyLineDraft(line);
    return (Object.keys(base) as MonthlyDraftField[]).some((field) => base[field] !== draft[field]);
  };

  const replaceLine = (next: MonthlySettlementLine) =>
    setView((prev) => (prev ? { ...prev, lines: prev.lines.map((l) => (l.id === next.id ? next : l)) } : prev));

  const handleAdd = async () => {
    if (!nextMonth) return;
    setAdding(true);
    try {
      const period = clipPeriodToMonth(
        toKstYmd(new Date(campaign.startDate)),
        toKstYmd(new Date(campaign.endDate)),
        nextMonth,
      );
      const lastRate = [...lines].reverse().find((l) => l.commissionRate != null)?.commissionRate;
      const created = await requestJson<MonthlySettlementLine>(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          yearMonth: nextMonth,
          ...period,
          commissionRate: lastRate ?? campaign.totalMarginRate ?? null,
        }),
      });
      await load();
      setExpanded((prev) => ({ ...prev, [created.id]: true }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "정산 줄을 추가하지 못했습니다.");
    } finally {
      setAdding(false);
    }
  };

  const handleSave = async (line: MonthlySettlementLine) => {
    const patch = buildMonthlyLinePatch(draftOf(line));
    if (!patch.ok) {
      setInvalid((prev) => ({ ...prev, [line.id]: patch.invalidField }));
      return;
    }
    setInvalid((prev) => ({ ...prev, [line.id]: null }));
    setSavingId(line.id);
    try {
      const saved = await requestJson<MonthlySettlementLine>(`${baseUrl}/${line.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch.body),
      });
      replaceLine(saved);
      setDrafts(({ [line.id]: _saved, ...rest }) => rest);
      // 성공 토스트는 저장 버튼이 단독 소유한다(P2 Toast Ownership).
      toast.success(`${formatMonthlyLineLabel(line.yearMonth)} 저장됨`);
      await refreshCampaign();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "저장하지 못했습니다.");
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleCheck = async (line: MonthlySettlementLine, key: MonthlyChecklistKey, checked: boolean) => {
    const value = checked ? toKstYmd(new Date()) : null;
    setPendingCheck({ id: line.id, key });
    replaceLine({ ...line, [key]: value });
    try {
      const saved = await requestJson<MonthlySettlementLine>(`${baseUrl}/${line.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      replaceLine(saved);
    } catch (error) {
      // 낙관 갱신을 되돌리고 실패만 알린다(인라인 저장 = 성공 무음).
      replaceLine(line);
      toast.error(error instanceof Error ? error.message : "체크를 저장하지 못했습니다.");
    } finally {
      setPendingCheck(null);
    }
  };

  const handleDelete = async (line: MonthlySettlementLine) => {
    try {
      await requestJson(`${baseUrl}/${line.id}`, { method: "DELETE" });
      setDrafts(({ [line.id]: _deleted, ...rest }) => rest);
      await load();
      await refreshCampaign();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "삭제하지 못했습니다.");
    }
  };

  const completed = lines.filter(isMonthlyLineComplete).length;
  const todayYmd = toKstYmd(new Date());

  return (
    <section className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarRange className="size-4 text-slate-500" />
          월별 정산
        </h3>
        {lines.length > 0 ? (
          completed === lines.length ? (
            <span className="flex items-center gap-1 text-xs tabular-nums text-status-success">
              <CheckCircle2 className="size-3" />
              {lines.length}줄 모두 완료
            </span>
          ) : (
            <span className="text-xs tabular-nums text-slate-600">
              {lines.length}줄 중 {completed}줄 완료 · 모든 줄 4/4여야 정산 완료
            </span>
          )
        ) : null}
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          월별 정산을 불러오지 못했습니다.
          <Button type="button" variant="outline" size="xs" onClick={() => void load()}>
            다시 불러오기
          </Button>
        </div>
      ) : view == null ? (
        <div role="status" className="h-14 animate-pulse rounded-xl bg-slate-50 motion-reduce:animate-none">
          <span className="sr-only">월별 정산 불러오는 중</span>
        </div>
      ) : lines.length === 0 ? (
        <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center">
          <div className="text-sm font-semibold text-foreground">월별 정산 줄이 없습니다</div>
          <p className="text-xs leading-relaxed text-slate-500">
            이 거래처는 월 단위로 계산서와 지급을 기록합니다. 줄이 1개 이상 있고 모두 4/4여야 정산을 완료할 수
            있습니다.
          </p>
        </div>
      ) : (
        <div>
          <div className={cn(GRID, "px-2 pb-1 text-[10px] text-slate-500")}>
            <span aria-hidden="true" />
            <span>귀속월</span>
            <span className="text-right">거래액</span>
            <span className="text-right">지급액</span>
            <span className="text-right">체크</span>
          </div>
          {lines.map((line) => {
            const open = Boolean(expanded[line.id]);
            const dirty = isDirty(line);
            const payment = resolveMonthlyPaymentAmount(line);
            const overdue =
              line.paymentDueDate && !line.paymentPaidAt && !isMonthlyLineComplete(line)
                ? daysOverdue(line.paymentDueDate, todayYmd)
                : 0;
            return (
              <div key={line.id} className="border-t border-slate-100 first:border-t-0">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((prev) => ({ ...prev, [line.id]: !open }))}
                  className={cn(GRID, "min-h-[52px] w-full rounded-lg px-2 py-2 text-left outline-none hover:bg-slate-50/70 focus-visible:ring-2 focus-visible:ring-focus-ring")}
                >
                  {open ? <ChevronDown className="size-4 text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" />}
                  <span className="grid min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                      {formatMonthlyLineLabel(line.yearMonth)}
                      {dirty ? (
                        <span className="rounded-md bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600">
                          저장 안 됨
                        </span>
                      ) : null}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {line.periodStart || line.periodEnd
                        ? `${formatShortYmd(line.periodStart)} ~ ${formatShortYmd(line.periodEnd)}`
                        : "귀속 기간 미입력"}
                    </span>
                  </span>
                  <span className="text-right text-xs tabular-nums text-slate-600">
                    <span className="sr-only">거래액 </span>
                    {line.transactionAmount == null ? "-" : `${formatCurrency(line.transactionAmount)}원`}
                  </span>
                  <span className="grid text-right">
                    <span className="text-[13px] font-semibold tabular-nums text-foreground">
                      <span className="sr-only">지급액 </span>
                      {payment == null ? "-" : `${formatCurrency(payment)}원`}
                    </span>
                    {line.paymentPaidAt ? (
                      <span className="text-[10px] tabular-nums text-slate-500">
                        지급 {formatShortYmd(line.paymentPaidAt)}
                      </span>
                    ) : line.paymentDueDate ? (
                      <span
                        className={cn(
                          "text-[10px] tabular-nums",
                          overdue > 0 ? "font-semibold text-status-urgent-text" : "text-slate-500",
                        )}
                      >
                        {overdue > 0 ? `기한 ${overdue}일 지남` : `기한 ${formatShortYmd(line.paymentDueDate)}`}
                      </span>
                    ) : null}
                  </span>
                  <CheckTicks line={line} />
                </button>
                {/* 접어도 초안은 패널 상태에 남는다 — 조건부 렌더가 입력을 지우지 않는다. */}
                {open ? (
                  <MonthlySettlementLineEditor
                    line={line}
                    draft={draftOf(line)}
                    isDirty={dirty}
                    isSaving={savingId === line.id}
                    invalidField={invalid[line.id] ?? null}
                    reference={view.orderDateReference[line.yearMonth] ?? null}
                    pendingCheckKey={pendingCheck?.id === line.id ? pendingCheck.key : null}
                    onDraftChange={(field, value) => {
                      setDrafts((prev) => ({ ...prev, [line.id]: { ...draftOf(line), [field]: value } }));
                      if (invalid[line.id] === field) setInvalid((prev) => ({ ...prev, [line.id]: null }));
                    }}
                    onSave={() => void handleSave(line)}
                    onCancel={() => setDrafts(({ [line.id]: _cancelled, ...rest }) => rest)}
                    onDelete={() => setDeleteTarget(line)}
                    onToggleCheck={(key, checked) => void handleToggleCheck(line, key, checked)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {view != null && !loadError ? (
        <>
          {nextMonth ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="xs" disabled={adding} onClick={() => void handleAdd()}>
                <Plus data-icon="inline-start" />
                {`${formatMonthlyLineLabel(nextMonth)} 정산 ${lines.length === 0 ? "줄 만들기" : "추가"}`}
              </Button>
              {/* 이전된 줄은 종료월에 생긴다(9/28~10/4 → 10월분) — 나눌 달이 그 앞이라는 사실을 알린다. */}
              {lines.length === 1 && nextMonth < lines[0].yearMonth ? (
                <span className="text-xs text-slate-500">
                  지금 금액은 {formatMonthlyLineLabel(lines[0].yearMonth)}에 모두 들어 있습니다.{" "}
                  {formatMonthlyLineLabel(nextMonth)}을 추가하면 두 줄로 나눠 입력하세요.
                </span>
              ) : null}
            </div>
          ) : null}
          {lines.length > 0 && completed === lines.length && campaign.status !== "COMPLETED" ? (
            // 체크를 끝내도 상태는 저절로 바뀌지 않는다(체크리스트 = 알림, 2026-09-09 결정). 다음 행동을 알린다.
            <p className="text-xs text-slate-600">
              모든 달이 4/4입니다. 입금·지급 완료를 표시하면 정산 완료로 넘어갑니다. 이미 표시했다면 상태를 정산
              완료로 바꿔주세요.
            </p>
          ) : null}
          {lines.length > 0 ? (
            <VerificationFooter lines={lines} campaignTransactionAmount={view.campaignTransactionAmount} />
          ) : null}
        </>
      ) : null}

      <AlertDialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget ? `${formatMonthlyLineLabel(deleteTarget.yearMonth)} 정산 줄을 삭제할까요?` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              입력한 거래액, 계산서, 지급 기록과 체크 {deleteTarget ? countMonthlyChecks(deleteTarget) : 0}칸 기록이
              사라지며 되돌릴 수 없습니다. 캠페인 물품대금은 남은 줄의 합계로 다시 계산됩니다.
              {lines.length === 1 ? " 마지막 줄을 지우면 새 줄을 만들 때까지 정산을 완료할 수 없습니다." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
