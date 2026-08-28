import { cn } from "@/lib/utils";

export interface CategoryBarSegment {
  label: string;
  value: number;
  /** CSS color — 승인 팔레트 토큰(var(--...)) 또는 hex. */
  color: string;
}

/**
 * CategoryBar — Tremor식 "구성 비율" 가로 세그먼트 바(+범례).
 *
 * 여러 KPI 숫자를 눈으로 합산하지 않고 "전체 중 각 항목이 얼마/몇 %"를 한 줄로
 * 보여준다. 미니멀 원칙: 그래픽만 더하고 텍스트는 최소(범례는 라벨+값+%).
 * 페이로드(값) 자체는 즉시 렌더 — 바 등장 애니메이션 없음.
 *
 * 색은 반드시 승인 팔레트(비용=슬레이트 계열·이익=골드·세금=앰버 등)에서 전달.
 */
export function CategoryBar({
  segments,
  total,
  formatValue = (v) => v.toLocaleString(),
  showLegend = true,
  legendClassName,
  className,
}: {
  segments: CategoryBarSegment[];
  /** 비율 분모(미지정 시 세그먼트 합). */
  total?: number;
  formatValue?: (value: number) => string;
  showLegend?: boolean;
  legendClassName?: string;
  className?: string;
}) {
  const sum = total ?? segments.reduce((acc, s) => acc + s.value, 0);

  return (
    <div className={className}>
      <div
        className="flex h-6 gap-0.5 overflow-hidden rounded-md"
        role="img"
        aria-label={segments
          .map((s) => `${s.label} ${formatValue(s.value)}`)
          .join(", ")}
      >
        {segments.map((s) => (
          <span
            key={s.label}
            className="block first:rounded-l-md last:rounded-r-md"
            style={{ flexGrow: Math.max(s.value, 0), backgroundColor: s.color }}
            title={`${s.label} ${formatValue(s.value)}`}
          />
        ))}
      </div>

      {showLegend ? (
        <div
          className={cn(
            "mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1",
            legendClassName,
          )}
        >
          {segments.map((s) => (
            <div key={s.label} className="flex items-center gap-1.5 text-[11px]">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              <span className="truncate text-muted-foreground">{s.label}</span>
              <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">
                {formatValue(s.value)}
                <span className="ml-1 text-[10px] font-normal tabular-nums text-muted-foreground/70">
                  {sum > 0 ? `${Math.round((s.value / sum) * 100)}%` : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
