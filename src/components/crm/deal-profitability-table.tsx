"use client";

import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { resolveProfitTone, PROFIT_TONE_TEXT_DENSE } from "@/lib/profit-tone";
import { InlineDataGrid } from "./inline-data-grid";

// --- Types ---

export type DealProfitabilityRow = {
  dealId: string;
  dealName: string;
  partnerName: string;
  totalRevenue: number;
  totalMargin: number;
  campaignCount: number;
  bestSeller: { id: string; name: string; sales: number } | null;
};

export type SortField =
  | "totalRevenue"
  | "totalMargin"
  | "campaignCount";

export type SortOrder = "asc" | "desc";

export type DealProfitabilityTableProps = {
  deals: DealProfitabilityRow[];
  sortBy: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  onSelect?: (deal: DealProfitabilityRow) => void;
};

// --- Component ---

export function DealProfitabilityTable({
  deals,
  onSelect,
}: Omit<DealProfitabilityTableProps, "sortBy" | "sortOrder" | "onSort">) {
  const rows: Array<DealProfitabilityRow & { id: string }> = deals.map((deal) => ({
    ...deal,
    id: deal.dealId,
  }));

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <InlineDataGrid
        rows={rows}
        columns={[
          {
            key: "dealName",
            label: "딜 이름",
            width: 240,
            render: (row) => (
              <span className="truncate text-xs font-medium text-foreground">
                {row.dealName}
              </span>
            ),
          },
          {
            key: "partnerName",
            label: "거래처",
            width: 160,
            render: (row) => (
              <span className="truncate text-xs text-foreground">
                {row.partnerName}
              </span>
            ),
          },
          {
            key: "totalRevenue",
            label: "총 매출",
            width: 140,
            render: (row) => (
              <span className="text-xs text-foreground tabular-nums">
                {formatCurrency(row.totalRevenue)}원
              </span>
            ),
          },
          {
            key: "totalMargin",
            label: "총 마진",
            width: 140,
            // 총 마진은 매출 × 순마진율로 상쇄된 **판정값**이다(P8 §1 판정축). 종전엔 부호와
            // 무관하게 무조건 초록이었다. 딜마다 되풀이되는 표 열이라 **밀집 강도** — 흑자는
            // 무색(옆 칸과 같은 본문색), 적자만 경고색(profit-tone SSOT).
            render: (row) => {
              const tone = resolveProfitTone(row.totalMargin);
              return (
                <span
                  className={cn(
                    "text-xs font-semibold text-foreground tabular-nums",
                    tone && PROFIT_TONE_TEXT_DENSE[tone],
                  )}
                >
                  {formatCurrency(row.totalMargin)}원
                </span>
              );
            },
          },
          {
            key: "campaignCount",
            label: "캠페인 수",
            width: 100,
            render: (row) => (
              <span className="text-xs text-muted-foreground tabular-nums">
                {row.campaignCount}건
              </span>
            ),
          },
          {
            key: "bestSeller",
            label: "최고 성과 셀러",
            width: 180,
            render: (row) => (
              <span className="truncate text-xs text-foreground">
                {row.bestSeller ? row.bestSeller.name : "-"}
              </span>
            ),
          },
        ]}
        onPatch={async () => null}
        onRowClick={(row) => onSelect?.(row)}
        disableInlineEdit
        persistId="deal-profitability-grid"
        className="border-0 bg-transparent"
      />
    </div>
  );
}
