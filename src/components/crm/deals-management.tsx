"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { toast } from "sonner";
import { PlusIcon, SearchIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  type DashboardData,
  dealStatusLabels,
  partnerTypeLabels,
  type DealStatus,
  type PartnerType,
} from "@/lib/crm-types";
import { CrmShell } from "./crm-shell";
import { DataSourceBanner } from "./data-source-banner";
import { InlineDataGrid, type GridColumn } from "./inline-data-grid";
import { DealCreationForm } from "./deal-creation-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type PartnerOption = {
  id: string;
  name: string;
  type: PartnerType;
};

type DealRow = {
  id: string;
  dealName: string;
  costPrice: number;
  listPrice?: number | null;
  status: DealStatus;
  partnerId: string;
  partnerName: string;
  baseMarginPolicy: string;
};

type DealsManagementProps = {
  initialDeals: DealRow[];
  partners: PartnerOption[];
  dataSource?: DashboardData["dataSource"];
  dataSourceMessage?: string;
};

const dealStatusOptions = Object.entries(dealStatusLabels).map(([value, label]) => ({
  value,
  label,
}));

export function DealsManagement({
  initialDeals,
  partners,
  dataSource,
  dataSourceMessage,
}: DealsManagementProps) {
  const [deals, setDeals] = useState(initialDeals);
  const [query, setQuery] = useState("");
  const [localQuery, setLocalQuery] = useState("");
  const [newDealSheetOpen, setNewDealSheetOpen] = useState(false);

  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  const debouncedSetQuery = useCallback((value: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      if (!isComposingRef.current) {
        setQuery(value);
      }
    }, 350);
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const partnerOptions = partners.map((partner) => ({
    value: partner.id,
    label: `${partner.name} - ${partnerTypeLabels[partner.type]}`,
  }));

  const columns: GridColumn<DealRow>[] = [
    { key: "dealName", label: "딜 이름", width: 320 },
    {
      key: "partnerId",
      label: "거래처",
      width: 240,
      type: "select",
      options: partnerOptions,
      render: (row) => (
        <span className="truncate text-foreground">{row.partnerName}</span>
      ),
    },
    {
      key: "status",
      label: "상태",
      width: 180,
      type: "select",
      options: dealStatusOptions,
    },
    { key: "listPrice", label: "정상가", width: 140, type: "number" },
  ];

  async function handleNewDealSuccess() {
    setNewDealSheetOpen(false);
    toast.success("새로운 딜이 성공적으로 추가되었습니다.");
    // Refresh deals list by fetching latest data
    try {
      const response = await fetch("/api/deals");
      if (response.ok) {
        const data = await response.json();
        const refreshedDeals: DealRow[] = (data.deals ?? data).map((deal: Record<string, unknown>) => ({
          id: deal.id as string,
          dealName: deal.dealName as string,
          costPrice: Number((deal.costPrice as { toString(): string })?.toString?.() ?? deal.costPrice ?? 0),
          listPrice: deal.listPrice != null ? Number(deal.listPrice.toString()) : null,
          status: (deal.status as DealStatus) ?? "SOURCING",
          partnerId: (deal.partnerId as string | null) ?? "",
          partnerName: ((deal.partner as Record<string, unknown>)?.name as string) ?? "거래처 없음",
          baseMarginPolicy: (deal.baseMarginPolicy as string) ?? "",
        }));
        setDeals(refreshedDeals);
      }
    } catch {
      // If refresh fails, reload the page as fallback
      window.location.reload();
    }
  }

  function toDealRowFromPatch(row: DealRow, patch: Partial<DealRow>) {
    if (!patch.partnerId) return patch;
    return {
      ...patch,
      partnerName: partners.find((partner) => partner.id === patch.partnerId)?.name ?? row.partnerName,
    };
  }

  return (
    <>
    <CrmShell>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {dataSource === "mock" && dataSourceMessage ? (
            <div className="px-5 pt-5">
              <DataSourceBanner message={dataSourceMessage} />
            </div>
          ) : null}
          <section className="flex min-h-12 shrink-0 items-center justify-between border-b border-border/70 px-5 py-3.5">
            <div className="text-xs text-muted-foreground font-medium">
              전체 딜 {deals.length}건
            </div>
            <div className="flex items-center gap-3">
              <InputGroup className="w-full sm:max-w-xs border border-slate-200 bg-white h-9 rounded-lg shadow-soft-sm">
                <InputGroupAddon>
                  {localQuery !== query ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <SearchIcon className="h-4 w-4 text-slate-400" />
                  )}
                </InputGroupAddon>
                <InputGroupInput
                  value={localQuery}
                  onChange={(event) => {
                    const val = event.target.value;
                    setLocalQuery(val);
                    if (!isComposingRef.current) {
                      debouncedSetQuery(val);
                    }
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    isComposingRef.current = false;
                    const val = (event.target as HTMLInputElement).value;
                    debouncedSetQuery(val);
                  }}
                  placeholder="딜 검색"
                  aria-label="딜 검색"
                  className="h-full border-0 focus-visible:ring-0 text-xs"
                />
              </InputGroup>
              <Button
                size="sm"
                className="rounded-lg h-9 text-xs"
                onClick={() => setNewDealSheetOpen(true)}
              >
                <PlusIcon data-icon="inline-start" className="size-3.5 mr-1" />
                신규 딜 등록
              </Button>
            </div>
          </section>
          <InlineDataGrid
            rows={deals}
            columns={columns}
            globalFilter={query}
            persistId="deals-management-grid"
            onPatch={async (id, patch) => {
              const current = deals.find((deal) => deal.id === id);
              if (!current) return null;
              
              return withMutationFeedback(
                (async () => {
                  const normalizedPatch = toDealRowFromPatch(current, patch);
                  const response = await fetch(`/api/deals/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(normalizedPatch),
                  });
                  if (!response.ok) throw new Error("딜 수정에 실패했습니다");
                  const updated = toDealRow(await response.json());
                  setDeals((previous) =>
                    previous.map((deal) => (deal.id === id ? updated : deal)),
                  );
                  return updated;
                })(),
                "딜 정보가 수정되었습니다."
              ).catch(() => null);
            }}
            onDelete={async (row) => {
              return withMutationFeedback(
                (async () => {
                  const response = await fetch(`/api/deals/${row.id}`, {
                    method: "DELETE",
                  });
                  if (!response.ok) throw new Error("딜 삭제에 실패했습니다");
                  setDeals((previous) => previous.filter((deal) => deal.id !== row.id));
                  return true;
                })(),
                "딜이 삭제되었습니다."
              ).catch(() => false);
            }}
          />
        </div>
      </section>
    </CrmShell>

    {/* New Deal Registration Dialog */}
    <Dialog open={newDealSheetOpen} onOpenChange={setNewDealSheetOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>신규 딜 등록</DialogTitle>
          <DialogDescription>
            거래처 제안에 대한 딜을 빠르게 등록합니다.
          </DialogDescription>
        </DialogHeader>
          <DealCreationForm
            onSuccess={handleNewDealSuccess}
            onCancel={() => setNewDealSheetOpen(false)}
          />
      </DialogContent>
    </Dialog>
    </>
  );
}

function toDealRow(deal: {
  id: string;
  dealName: string;
  costPrice: { toString(): string } | number | string;
  listPrice?: { toString(): string } | number | string | null;
  status: string;
  partnerId?: string | null;
  partner?: { name: string } | null;
  baseMarginPolicy: string;
}): DealRow {
  return {
    id: deal.id,
    dealName: deal.dealName,
    costPrice: Number(deal.costPrice.toString()),
    listPrice: deal.listPrice != null ? Number(deal.listPrice.toString()) : null,
    status: deal.status as DealStatus,
    partnerId: deal.partnerId ?? "",
    partnerName: deal.partner?.name ?? "거래처 없음",
    baseMarginPolicy: deal.baseMarginPolicy,
  };
}
