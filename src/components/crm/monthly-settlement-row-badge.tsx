/**
 * 정산 목록 행의 「그 달 줄」 요약(T-240) — 월 필터 기간의 월별 줄을 「9월분 3/4」 배지와 금액 한 줄로.
 * 같은 캠페인이 9월·10월 목록에 각자 자기 달 줄로 보이므로, 행의 캠페인 단위 금액과 혼동하지 않게
 * 그 달 거래액·지급액을 배지 바로 아래에 함께 싣는다(ss-ux-designer 검토 P1-1).
 *
 * 색은 정산 목록 `SlotIconBadge` 와 같은 문법 — 4/4 = 완료(`status-success`), 그 외 중립. 심각도는 싣지 않는다.
 */
import { CheckCircle2 } from "lucide-react";
import { badgeSizeClassName } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { formatMonthlyLineLabel, MONTHLY_CHECKLIST_ITEMS } from "@/lib/monthly-settlement";
import type { SettlementReportMonthlyLine } from "@/lib/settlement-report";

export function MonthlySettlementRowBadges({ lines }: { lines: SettlementReportMonthlyLine[] | undefined }) {
  if (!lines || lines.length === 0) return null;
  const total = MONTHLY_CHECKLIST_ITEMS.length;
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line) => {
        const label = formatMonthlyLineLabel(line.yearMonth);
        return (
          <div key={line.yearMonth} className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                badgeSizeClassName.compact,
                "inline-flex items-center gap-1",
                line.isComplete
                  ? "bg-status-success-bg text-status-success ring-1 ring-status-success"
                  : "bg-slate-100 text-slate-600",
              )}
            >
              <span aria-hidden="true" className="inline-flex items-center gap-1">
                {line.isComplete ? <CheckCircle2 className="size-[1.2em]" /> : null}
                {label} {line.checks}/{total}
              </span>
              <span className="sr-only">
                {label} 체크리스트 {total}개 중 {line.checks}개 완료
              </span>
            </span>
            <span className="text-[10px] tabular-nums text-slate-600">
              이 달 거래액 {formatCurrency(line.transactionAmount)}원 · 지급 {formatCurrency(line.paymentAmount)}원
            </span>
          </div>
        );
      })}
    </div>
  );
}
