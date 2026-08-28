"use client";

import { Badge } from "@/components/ui/badge";
import { dealStatusLabels } from "@/lib/deal-status";
import { summarizeDealStatuses } from "@/lib/deal-status";
import type { DealStatus } from "@/lib/deal-status";

type ProgressStatusSummaryProps = {
  deals: Array<{ status: string }>;
};

/**
 * Displays a summary of linked deal statuses as badges with counts.
 * Shows "연결된 딜이 없습니다" when no deals are linked.
 */
export function ProgressStatusSummary({ deals }: ProgressStatusSummaryProps) {
  if (deals.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">연결된 딜이 없습니다</p>
    );
  }

  const statusCounts = summarizeDealStatuses(deals);

  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(statusCounts).map(([status, count]) => {
        const label =
          dealStatusLabels[status as DealStatus] ?? status;
        return (
          <Badge
            key={status}
            variant="secondary"
            className="rounded-2xl px-2.5 font-medium shadow-none"
          >
            {label} {count}
          </Badge>
        );
      })}
    </div>
  );
}
