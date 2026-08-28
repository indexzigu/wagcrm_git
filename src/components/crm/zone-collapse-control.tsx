"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineZone } from "@/lib/zone-config";
import { ZONE_LABELS } from "@/lib/zone-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZoneCollapseControlProps = {
  zone: PipelineZone;
  expanded: boolean;
  disabled?: boolean; // 마지막 펼쳐진 존일 때
  onToggle: () => void;
};

// ---------------------------------------------------------------------------
// ZoneCollapseControl Component
// ---------------------------------------------------------------------------

/**
 * Toggle button for collapsing/expanding a pipeline zone.
 *
 * Features:
 * - aria-expanded attribute reflects current state
 * - Keyboard interaction (Enter/Space) via native button
 * - Disabled state prevents collapsing the last expanded zone
 * - Visual chevron indicator for expand/collapse state
 */
export function ZoneCollapseControl({
  zone,
  expanded,
  disabled = false,
  onToggle,
}: ZoneCollapseControlProps) {
  const label = ZONE_LABELS[zone];

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      aria-label={`${label} 존 ${expanded ? "접기" : "펼치기"}`}
      disabled={disabled}
      onClick={onToggle}
      className="h-7 w-7 p-0"
    >
      {expanded ? (
        <ChevronDownIcon className="h-4 w-4" />
      ) : (
        <ChevronRightIcon className="h-4 w-4" />
      )}
    </Button>
  );
}
