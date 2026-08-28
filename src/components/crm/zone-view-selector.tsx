"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ZoneViewMode } from "@/lib/zone-config";

type ZoneViewSelectorProps = {
  currentView: ZoneViewMode;
  onViewChange: (view: ZoneViewMode) => void;
  disabled?: boolean;
};

export function ZoneViewSelector({
  currentView,
  onViewChange,
  disabled = false,
}: ZoneViewSelectorProps) {
  const selector = (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={currentView}
      onValueChange={(value) => {
        if (!value || disabled) return;
        onViewChange(value as ZoneViewMode);
      }}
      disabled={disabled}
      className={disabled ? "opacity-50 cursor-not-allowed" : ""}
    >
      <ToggleGroupItem
        value="VIEW_B"
        aria-label="3-Zone 뷰"
        className="rounded-lg"
      >
        3-Zone
      </ToggleGroupItem>
      <ToggleGroupItem
        value="VIEW_C"
        aria-label="분리형 뷰"
        className="rounded-lg"
      >
        분리형
      </ToggleGroupItem>
    </ToggleGroup>
  );

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>{selector}</div>
          </TooltipTrigger>
          <TooltipContent>
            칸반 뷰에서만 전환 가능합니다
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return selector;
}
