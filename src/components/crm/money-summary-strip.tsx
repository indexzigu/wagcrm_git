import { Download, PiggyBank, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { MONEY_TERMS } from "@/lib/ui-glossary";
import { cn } from "@/lib/utils";

export type MoneySummaryItem = {
  key: string;
  /** 돈 이름은 `MONEY_TERMS` label, 상태 낱말은 붙여 쓴 한 낱말(「입금대기」). */
  label: string;
  /** null = 아직 불러오지 않음 → 「—」. */
  value: number | null;
  icon?: LucideIcon;
};

/**
 * 돈 흐름 네 칸 — 총거래액 · 수수료매출 · 셀러지급액 · 매출총이익. 정산 관리와 판매 관리가
 * **같은 네 칸·같은 순서·같은 아이콘**을 쓰도록(오너 결정) 칸 구성은 여기 한 곳이 정한다.
 */
export function moneyFlowGroup(values: {
  grossMerchandise: number | null;
  commissionRevenue: number | null;
  sellerPayout: number | null;
  grossProfit: number | null;
}): MoneySummaryItem[] {
  return [
    { key: "grossMerchandise", label: MONEY_TERMS.grossMerchandise.label, value: values.grossMerchandise, icon: TrendingUp },
    { key: "commissionRevenue", label: MONEY_TERMS.commissionRevenue.label, value: values.commissionRevenue, icon: Wallet },
    { key: "sellerPayout", label: MONEY_TERMS.sellerPayout.label, value: values.sellerPayout, icon: Download },
    { key: "grossProfit", label: MONEY_TERMS.grossProfit.label, value: values.grossProfit, icon: PiggyBank },
  ];
}

/**
 * 화면 위 금액 요약띠 — 정산 관리·판매 관리 공용(애플 UI 리뉴얼 묶음 2).
 *
 * 그룹 사이는 세로 헤어라인, 그룹 안 칸 사이는 간격만. 콘텐츠 면이라 불투명(`bg-card`) —
 * 반투명 유리는 머리·사이드바·시트 같은 크롬에만 쓴다. 색은 싣지 않는다: 합계 칸은 판정이
 * 아니라 사실이라(P8 색 사용 원칙 §2) 아이콘·값 모두 무채색이다.
 */
export function MoneySummaryStrip({
  groups,
  className,
}: {
  groups: ReadonlyArray<ReadonlyArray<MoneySummaryItem>>;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="금액 요약"
      className={cn(
        "flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-soft-sm",
        className,
      )}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.map((item) => item.key).join("|")}
          className={cn(
            "flex flex-wrap items-center gap-x-6 gap-y-2",
            groupIndex > 0 && "border-l border-border pl-6",
          )}
        >
          {group.map(({ key, label, value, icon: Icon }) => (
            <div key={key} className="flex shrink-0 items-center gap-1.5">
              {Icon ? <Icon aria-hidden className="size-3.5 text-muted-foreground" /> : null}
              <span data-slot="money-summary-label" className="font-medium">
                {label}:
              </span>
              <span className="tabular-nums font-semibold text-foreground">
                {value == null ? "—" : `${formatCurrency(value)}원`}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
