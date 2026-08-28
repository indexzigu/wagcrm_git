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

  const textClass = isHeading
    ? "truncate text-sm font-medium text-foreground"
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
            <span className={currentTextClass}>
              {part.value}
            </span>
          </span>
        );
      })}
    </span>
  );
}
