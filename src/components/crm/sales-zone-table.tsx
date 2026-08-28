"use client";

import * as React from "react";
import { ArrowUpDownIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  campaignStatusLabels,
  type CampaignRow,
  type CampaignStatus,
} from "@/lib/crm-types";
import { formatNumber } from "@/lib/format";
import { patchCampaign } from "@/lib/campaign-patch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SalesZoneTableProps = {
  campaigns: CampaignRow[];
  onRowOpen: (campaign: CampaignRow) => void;
  onCampaignUpdate: (campaign: CampaignRow) => void;
};

type SortDirection = "asc" | "desc";
type SortKey =
  | "sellerName"
  | "dealName"
  | "partnerName"
  | "status"
  | "followers"
  | "startDate";

const statusValues: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "COMPLETED",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentFollowers(campaign: CampaignRow): number | null {
  if (campaign.followerHistory.length === 0) return null;
  return campaign.followerHistory[campaign.followerHistory.length - 1]!.followers;
}

function dateText(value: string) {
  return value.slice(5).replace("-", ".");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SalesZoneTable({
  campaigns,
  onRowOpen,
  onCampaignUpdate,
}: SalesZoneTableProps) {
  const [sort, setSort] = React.useState<{
    key: SortKey;
    direction: SortDirection;
  }>({ key: "startDate", direction: "desc" });

  const toggleSort = React.useCallback((key: SortKey) => {
    setSort((current) => {
      if (current.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "desc" };
    });
  }, []);

  const sortedCampaigns = React.useMemo(() => {
    return [...campaigns].sort((a, b) => {
      let comparison = 0;
      switch (sort.key) {
        case "sellerName":
          comparison = a.sellerName.localeCompare(b.sellerName, "ko");
          break;
        case "dealName":
          comparison = a.dealName.localeCompare(b.dealName, "ko");
          break;
        case "partnerName":
          comparison = a.partnerName.localeCompare(b.partnerName, "ko");
          break;
        case "status":
          comparison = a.status.localeCompare(b.status);
          break;
        case "followers": {
          const fa = getCurrentFollowers(a) ?? 0;
          const fb = getCurrentFollowers(b) ?? 0;
          comparison = fa - fb;
          break;
        }
        case "startDate":
          comparison = a.startDate.localeCompare(b.startDate);
          break;
      }
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [campaigns, sort]);

  const handlePatch = React.useCallback(
    async (campaignId: string, patch: Partial<CampaignRow>) => {
      // Optimistic update
      const original = campaigns.find((c) => c.id === campaignId);
      if (!original) return;

      const optimistic = { ...original, ...patch };
      onCampaignUpdate(optimistic);

      const result = await patchCampaign<CampaignRow>(campaignId, patch, {
        fallbackError: "저장에 실패했습니다. 다시 시도해주세요.",
        networkError: "저장에 실패했습니다. 다시 시도해주세요.",
      });

      if (!result.ok) {
        // Rollback
        onCampaignUpdate(original);
        toast.error(result.error);
        return;
      }

      onCampaignUpdate(result.data);
    },
    [campaigns, onCampaignUpdate],
  );

  const columns: {
    key: SortKey;
    label: string;
    width: number;
  }[] = [
    { key: "sellerName", label: "셀러명", width: 140 },
    { key: "dealName", label: "딜명", width: 200 },
    { key: "partnerName", label: "거래처명", width: 140 },
    { key: "status", label: "제안 상태", width: 150 },
    { key: "followers", label: "팔로워 수", width: 120 },
    { key: "startDate", label: "시작일", width: 100 },
  ];

  return (
    <div className="border-y border-border/70 bg-transparent">
      <div
        className="overflow-x-auto"
        role="region"
        aria-label="영업 존 테이블"
        tabIndex={0}
      >
        <Table className="min-w-[990px] text-[13px]">
          <TableHeader className="sticky top-0 z-10 bg-white/90 supports-backdrop-filter:backdrop-blur">
            <TableRow className="border-b border-slate-200 hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  style={{ width: col.width }}
                  className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                >
                  <Button
                    variant="ghost"
                    size="xs"
                    className="-ml-1 h-8 rounded-md px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    <ArrowUpDownIcon data-icon="inline-end" />
                  </Button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCampaigns.length === 0 ? (
              <TableRow className="border-0 hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-64">
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <span className="text-xs font-medium">0</span>
                      </EmptyMedia>
                      <EmptyTitle>제안 캠페인이 없습니다</EmptyTitle>
                      <EmptyDescription>
                        PROPOSAL 상태의 캠페인이 없습니다.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              sortedCampaigns.map((campaign) => (
                <TableRow
                  key={campaign.id}
                  className="border-b border-slate-200/80 bg-white/60 transition-colors duration-150 hover:bg-white cursor-pointer"
                  onClick={() => onRowOpen(campaign)}
                >
                  {/* 셀러명 */}
                  <TableCell className="h-11 px-3">
                    <span className="block truncate text-foreground">
                      {campaign.sellerName}
                    </span>
                  </TableCell>

                  {/* 딜명 */}
                  <TableCell className="h-11 px-3">
                    <span className="block truncate font-medium text-foreground">
                      {campaign.dealName}
                    </span>
                  </TableCell>

                  {/* 거래처명 */}
                  <TableCell className="h-11 px-3">
                    <span className="block truncate text-muted-foreground">
                      {campaign.partnerName}
                    </span>
                  </TableCell>

                  {/* 제안 상태 (editable dropdown) */}
                  <TableCell className="h-11 px-3">
                    <StatusDropdown
                      campaign={campaign}
                      onPatch={handlePatch}
                    />
                  </TableCell>

                  {/* 팔로워 수 */}
                  <TableCell className="h-11 px-3">
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {formatNumber(getCurrentFollowers(campaign))}
                    </span>
                  </TableCell>

                  {/* 시작일 */}
                  <TableCell className="h-11 px-3">
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {dateText(campaign.startDate)}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Editable Cells
// ---------------------------------------------------------------------------

function StatusDropdown({
  campaign,
  onPatch,
}: {
  campaign: CampaignRow;
  onPatch: (id: string, patch: Partial<CampaignRow>) => Promise<void>;
}) {
  return (
    <Select
      value={campaign.status}
      onValueChange={(value) =>
        onPatch(campaign.id, { status: value as CampaignStatus })
      }
    >
      <SelectTrigger
        className="h-8 w-full border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-slate-100 focus:ring-0"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue>
          {campaignStatusLabels[campaign.status]}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {statusValues.map((status) => (
            <SelectItem key={status} value={status}>
              {campaignStatusLabels[status]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}


