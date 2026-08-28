"use client";

import { ChevronDown, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { statusBarClassName } from "@/components/crm/status-badge";
import { campaignStatusLabels, type CampaignStatus } from "@/lib/crm-types";
import { cn } from "@/lib/utils";

export type CalendarSellerOption = { id: string; name: string; count: number };

type CalendarFilterBarProps = {
  sellers: CalendarSellerOption[];
  selectedSellerIds: Set<string> | null; // null = 전체
  onSellerToggle: (id: string) => void;
  selectedStatuses: Set<CampaignStatus> | null; // null = 전체
  onStatusToggle: (status: CampaignStatus) => void;
  hasActiveFilters: boolean;
  onReset: () => void;
};

export function CalendarFilterBar({
  sellers,
  selectedSellerIds,
  onSellerToggle,
  selectedStatuses,
  onStatusToggle,
  hasActiveFilters,
  onReset,
}: CalendarFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-xs"
          >
            <UserRound className="size-3.5" aria-hidden="true" />
            셀러
            {selectedSellerIds && (
              <Badge variant="secondary" size="count">
                {selectedSellerIds.size}
              </Badge>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuLabel>이 달의 셀러</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {sellers.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              셀러가 없습니다.
            </div>
          ) : (
            sellers.map((seller) => (
              <DropdownMenuCheckboxItem
                key={seller.id}
                checked={selectedSellerIds?.has(seller.id) ?? false}
                // 다중 선택: 항목 선택 시 메뉴가 닫히지 않도록 기본 동작 차단
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onSellerToggle(seller.id)}
              >
                <span className="min-w-0 flex-1 truncate">{seller.name}</span>
                <span className="ml-2 text-[10px] text-muted-foreground">
                  {seller.count}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-xs"
          >
            상태
            {selectedStatuses && (
              <Badge variant="secondary" size="count">
                {selectedStatuses.size}
              </Badge>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>상태</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(
            Object.entries(campaignStatusLabels) as [CampaignStatus, string][]
          ).map(([status, label]) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={selectedStatuses?.has(status) ?? false}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onStatusToggle(status)}
            >
              <span
                className={cn("size-2.5 shrink-0 rounded-[3px]", statusBarClassName[status])}
              />
              {label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onReset}
          className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          필터 초기화
        </button>
      )}
    </div>
  );
}
