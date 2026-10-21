"use client";

import { Button } from "@/components/ui/button";
import type { StageFilter } from "@/hooks/use-stage-filter";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageFilterBarProps {
  currentFilter: StageFilter;
  onFilterChange: (filter: StageFilter) => void;
  counts: Record<StageFilter, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILTER_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: "ALL", label: "전체" },
  { value: "SALES", label: "영업" },
  { value: "PROGRESS", label: "진행" },
  { value: "SETTLEMENT", label: "정산" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StageFilterBar({
  currentFilter,
  onFilterChange,
  counts,
}: StageFilterBarProps) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="단계 필터">
      {FILTER_OPTIONS.map(({ value, label }) => {
        const isActive = currentFilter === value;
        return (
          <Button
            key={value}
            variant="ghost"
            size="sm"
            aria-pressed={isActive}
            onClick={() => onFilterChange(value)}
            className={cn(
              "rounded-lg",
              isActive
                ? "bg-primary/10 font-bold text-primary hover:bg-primary/10 hover:text-primary"
                : "font-medium text-slate-500",
            )}
          >
            {label}
            <span
              className={cn(
                "ml-1 inline-flex items-center justify-center rounded-md px-1.5 text-xs tabular-nums",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-slate-600",
              )}
            >
              {counts[value]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
