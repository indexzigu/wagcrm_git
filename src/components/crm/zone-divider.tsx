"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { PipelineZone } from "@/lib/zone-config";
import { ZONE_LABELS } from "@/lib/zone-config";

// ---------------------------------------------------------------------------
// Zone background colors — distinct tint per zone with WCAG AA contrast (4.5:1)
// Text colors are chosen to meet contrast requirements against their backgrounds.
// ---------------------------------------------------------------------------

const ZONE_STYLES: Record<PipelineZone, { bg: string; text: string }> = {
  SALES: {
    bg: "bg-blue-50",
    text: "text-blue-900",
  },
  DEAL_EXECUTION: {
    bg: "bg-amber-50",
    text: "text-amber-900",
  },
  SETTLEMENT: {
    bg: "bg-emerald-50",
    text: "text-emerald-900",
  },
  DROPPED: {
    bg: "bg-rose-50",
    text: "text-rose-900",
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZoneDividerProps {
  zone: PipelineZone;
  campaignCount: number;
}

// ---------------------------------------------------------------------------
// ZoneDivider Component
// ---------------------------------------------------------------------------

/**
 * Horizontal banner-style header positioned above each zone's column group.
 * Replaces the previous vertical divider line.
 *
 * Features:
 * - Full-width horizontal banner with min-height 36px
 * - Zone label + campaign count badge inline
 * - Distinct background color per zone with subtle tint
 * - WCAG AA contrast ratio (4.5:1) between text and background
 * - role="separator" with aria-orientation="horizontal" for accessibility
 */
export function ZoneDivider({ zone, campaignCount }: ZoneDividerProps) {
  const label = ZONE_LABELS[zone];
  const styles = ZONE_STYLES[zone];

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`${label} 존`}
      className={cn(
        "flex min-h-[36px] w-full items-center gap-2 rounded-md px-3 py-1.5",
        styles.bg,
      )}
    >
      <span className={cn("text-sm font-semibold", styles.text)}>
        {label}
      </span>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
          styles.bg,
          styles.text,
          "border border-current/10",
        )}
      >
        {campaignCount}
      </span>
    </div>
  );
}
