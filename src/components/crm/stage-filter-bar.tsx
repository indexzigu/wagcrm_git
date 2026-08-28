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
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={isActive}
            onClick={() => onFilterChange(value)}
            className={cn(
              "rounded-lg",
              isActive && "bg-slate-200 text-slate-900 font-semibold",
            )}
          >
            {label}
            <span
              className={cn(
                "ml-1 inline-flex items-center justify-center rounded-md px-1.5 text-xs tabular-nums",
                isActive
                  ? "bg-slate-900/10 text-slate-700"
                  : "bg-muted text-muted-foreground",
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
