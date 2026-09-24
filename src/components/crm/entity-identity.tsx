import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type EntityIdentityPart = {
  label: string;
  value: string;
};

type EntityIdentityProps = {
  parts: EntityIdentityPart[];
  className?: string;
  variant?: "default" | "compact" | "heading";
};

export function EntityIdentity({ parts, className, variant = "default" }: EntityIdentityProps) {
  if (parts.length === 0) return null;

  const isHeading = variant === "heading";
  const isCompact = variant === "compact";

  const badgeClass = isHeading
    ? "h-5 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground bg-slate-50"
    : isCompact
      ? "h-4 rounded-sm px-1 py-0 text-[9px] font-medium text-muted-foreground"
      : "h-5 rounded-md px-1.5 py-0 text-[9px] font-medium text-muted-foreground bg-slate-50";

  // 말줄임 정책: 헤딩(폼에서 선택한 대상의 요약 머리)은 줄바꿈해 전체를 보인다 — 자동 조합
  // 캠페인명(`[딜] - [셀러] N차`)은 원래 길고, 잘리면 구별 꼬리(회차)가 먼저 사라진다.
  // 목록·표(default·compact)는 밀도를 위해 한 줄 말줄임을 유지하되 title 로 전체값에 닿게 한다
  // (DOM 텍스트는 원래 전체라 화면낭독기는 잘림과 무관하다).
  const textClass = isHeading
    ? "min-w-0 break-words text-sm font-medium text-foreground"
    : isCompact
      ? "truncate text-[10px] text-muted-foreground"
      : "truncate text-xs font-medium text-muted-foreground";

  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-2", className)}>
      {parts.map((part, index) => {
        const isFirst = index === 0;
        const currentTextClass = isFirst && !isCompact ? cn(textClass, "text-foreground font-semibold") : textClass;

        return (
          <span
            key={`${part.label}-${part.value}`}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            <Badge
              variant="outline"
              className={badgeClass}
            >
              {part.label}
            </Badge>
            <span className={currentTextClass} title={isHeading ? undefined : part.value}>
              {part.value}
            </span>
          </span>
        );
      })}
    </span>
  );
}
