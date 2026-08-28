"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { PlusIcon, SearchIcon } from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { DealsGrid, type DealRow } from "@/components/crm/deals-grid";
import { useDeals } from "@/hooks/useDeals";
import {
  DealsPanel,
} from "@/components/crm/deals-panel";
import {
  DealProfitabilityTable,
  type DealProfitabilityRow,
} from "@/components/crm/deal-profitability-table";
import { useFilterParams } from "@/hooks/use-filter-params";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import type { DealStatus } from "@/lib/crm-types";
import { FilterPopover, type FilterFieldConfig } from "@/components/crm/filter-popover";
import { CSVImportDialog } from "@/components/crm/csv-import-dialog";
import { DealCreationForm } from "@/components/crm/deal-creation-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { dealStatusLabels } from "@/lib/crm-types";

// Filter config for deals (lifted from DealsGrid)
const dealStatusValues: DealStatus[] = [
  "SOURCING",
  "NEGOTIATING",
  "SAMPLE_TESTING",
  "CONFIRMED",
  "DROPPED",
];

const dealFilterConfig: FilterFieldConfig[] = [
  {
    key: "status",
    label: "상태",
    type: "select",
    options: dealStatusValues.map((s) => ({
      value: s,
      label: dealStatusLabels[s],
    })),
  },
];

type DealsPageClientProps = {
  initialDeals: DealRow[];
};

export function DealsPageClient({
  initialDeals,
}: DealsPageClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { filters, setFilter, clearFilters } = useFilterParams();
  const activeTab = filters.tab || "deals";

  // --- useDeals Custom Hook integration ---
  const {
    deals,
    newDealDialogOpen,
    setNewDealDialogOpen,
    selectedDeal,
    setSelectedDeal,
    panelOpen,
    setPanelOpen,
    profitabilityDeals,
    profitabilityLoading,
    handleNewDealSuccess,
    fetchDealDetail,
    fetchProfitabilityDeals,
    handleDealUpdated,
    handleDealDeleted,
  } = useDeals(initialDeals);

  const query = filters.q || "";
  const activeStatus = filters.status || "";
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Local search input state for IME composition support (Korean input)
  const [localQuery, setLocalQuery] = useState(query);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local query when URL param changes externally
  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  // Debounced search: only triggers when >= 2 chars and not composing
  const debouncedSetFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (!isComposingRef.current) {
          if (value.trim().length >= 2 || value.trim().length === 0) {
            setFilter("q", value);
          }
        }
      }, 350);
    },
    [setFilter]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Filtering logic (lifted from DealsGrid)
  const visibleDeals = useMemo(() => {
    let filtered = deals;

    // Apply status filter
    if (activeStatus) {
      filtered = filtered.filter((deal) => {
        if (activeStatus === "CONFIRMED") {
          return deal.status === "CONFIRMED" || deal.status === "ARCHIVED";
        }
        return deal.status === activeStatus;
      });
    }

    // Apply text search — use the URL query (debounced) for stable filtering
    const normalized = query.trim().toLowerCase();
    if (normalized) {
      filtered = filtered.filter(
        (deal) =>
          deal.dealName.toLowerCase().includes(normalized) ||
          deal.partnerName.toLowerCase().includes(normalized)
      );
    }

    return filtered;
  }, [deals, query, activeStatus]);

  // Fetch profitability data when the analysis tab is active.
  useEffect(() => {
    if (activeTab !== "profitability") return;

    const cancelledRef = { cancelled: false };
    void fetchProfitabilityDeals(cancelledRef);

    return () => {
      cancelledRef.cancelled = true;
    };
  }, [activeTab, fetchProfitabilityDeals]);

  // Alias fetchDealDetail to handleSelect for compatibility with other handlers
  const handleSelect = fetchDealDetail;

  useEffect(() => {
    const dealId = searchParams.get("dealId");
    if (!dealId) return;
    if (selectedDeal?.id === dealId && panelOpen) return;
    const target = initialDeals.find((deal) => deal.id === dealId);
    if (target) {
      const timer = setTimeout(() => {
        void handleSelect(target);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [handleSelect, initialDeals, panelOpen, searchParams, selectedDeal?.id]);

  const handleProfitabilitySelect = useCallback(
    (row: DealProfitabilityRow) => {
      // Map profitability row to DealRow shape for handleSelect
      const dealRow: DealRow = {
        id: row.dealId,
        dealName: row.dealName,
        partnerName: row.partnerName,
        partnerId: "",
        costPrice: 0,
        sellingPrice: 0,
        status: "SOURCING",
        campaignCount: row.campaignCount,
        taskCount: 0,
        sellerCount: 0,
        createdAt: new Date().toISOString(),
      };
      handleSelect(dealRow);
    },
    [handleSelect]
  );

  const dealStats = useMemo(() => {
    const activeCount = initialDeals.filter((d) =>
      ["NEGOTIATING", "SAMPLE_TESTING", "ARCHIVED"].includes(d.status)
    ).length;
    const sourcingCount = initialDeals.filter(
      (d) => d.status === "SOURCING"
    ).length;
    const totalCampaigns = initialDeals.reduce(
      (sum, d) => sum + (d.campaignCount ?? 0),
      0
    );
    return { activeCount, sourcingCount, totalCampaigns };
  }, [initialDeals]);

  return (
    <>
      <CrmShell>
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
          {/* 1줄 통계 요약 바 (유리 박스 외부 상단 배치) */}
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-400 shrink-0">
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-medium">전체 딜:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{initialDeals.length}개</span>
            </div>
            <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-medium">진행 중:</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">{dealStats.activeCount}개</span>
            </div>
            <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-medium">소싱 중:</span>
              <span className="font-semibold text-amber-600 dark:text-amber-400">{dealStats.sourcingCount}개</span>
            </div>
            <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-medium">총 캠페인:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{dealStats.totalCampaigns}건</span>
            </div>
          </div>

          {/* 테이블 카드 컨테이너 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
            {/* 탭 & 조작 도구 인라인 배치 (CSV 제거) */}
            <section className="flex min-h-12 shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/70 px-5 py-3">
              <Tabs value={activeTab} onValueChange={(v) => setFilter("tab", v)}>
                <TabsList className="h-9 bg-transparent p-0">
                  <TabsTrigger
                    value="deals"
                    className="h-9 rounded-none border-b-2 border-transparent bg-transparent px-3 text-xs text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    딜 목록
                  </TabsTrigger>
                  <TabsTrigger
                    value="profitability"
                    className="h-9 rounded-none border-b-2 border-transparent bg-transparent px-3 text-xs text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    수익성 분석
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="flex items-center gap-2">
                <InputGroup className="w-full sm:max-w-xs border border-slate-200 bg-white h-9 rounded-lg shadow-soft-sm">
                  <InputGroupAddon>
                    <SearchIcon className="h-4 w-4 text-muted-foreground" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={localQuery}
                    onChange={(e) => {
                      const val = e.target.value;
                      setLocalQuery(val);
                      if (!isComposingRef.current) {
                        debouncedSetFilter(val);
                      }
                    }}
                    onCompositionStart={() => {
                      isComposingRef.current = true;
                    }}
                    onCompositionEnd={(e) => {
                      isComposingRef.current = false;
                      const val = (e.target as HTMLInputElement).value;
                      debouncedSetFilter(val);
                    }}
                    placeholder="딜 검색 (2글자 이상)"
                    aria-label="딜 검색"
                    className="h-full text-xs"
                  />
                </InputGroup>
                <FilterPopover
                  filterConfig={dealFilterConfig}
                  filters={{ status: activeStatus }}
                  onFilterChange={(_, val) => setFilter("status", val)}
                  onClearAll={clearFilters}
                />
                <Button
                  size="sm"
                  className="rounded-lg h-9 text-xs"
                  onClick={() => setNewDealDialogOpen(true)}
                >
                  <PlusIcon className="h-3.5 w-3.5 mr-1" />
                  딜 추가
                </Button>
              </div>
            </section>

            {/* 탭 콘텐츠 */}
            {activeTab === "deals" ? (
              <DealsGrid initialDeals={visibleDeals} onSelect={handleSelect} />
            ) : profitabilityLoading ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                로딩 중...
              </div>
            ) : (
              <DealProfitabilityTable
                deals={profitabilityDeals}
                onSelect={handleProfitabilitySelect}
              />
            )}
          </div>
        </section>
      </CrmShell>
  
        <DealsPanel
          deal={selectedDeal}
          open={panelOpen}
          onOpenChange={(open) => {
            setPanelOpen(open);
            if (!open) {
              setSelectedDeal(null);
              const dealId = searchParams.get("dealId");
              if (dealId) {
                const from = searchParams.get("from");
                const partnerId = searchParams.get("partnerId");
                const sellerId = searchParams.get("sellerId");

                if (from === "partners" && partnerId) {
                  router.push(`/partners?selectedPartner=${partnerId}`);
                } else if (from === "sellers" && sellerId) {
                  router.push(`/sellers?selectedSeller=${sellerId}`);
                } else {
                  const params = new URLSearchParams(searchParams.toString());
                  params.delete("dealId");
                  params.delete("from");
                  params.delete("partnerId");
                  params.delete("sellerId");
                  const queryString = params.toString();
                  router.push(`/deals${queryString ? `?${queryString}` : ""}`);
                }
              }
            }
          }}
          onUpdated={handleDealUpdated}
          onDeleted={handleDealDeleted}
        />

        {/* New Deal Registration Dialog */}
        <Dialog open={newDealDialogOpen} onOpenChange={setNewDealDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>신규 딜 등록</DialogTitle>
              <DialogDescription>
                거래처 제안에 대한 딜을 빠르게 등록합니다.
              </DialogDescription>
            </DialogHeader>
              <DealCreationForm
                onSuccess={handleNewDealSuccess}
                onCancel={() => setNewDealDialogOpen(false)}
              />
          </DialogContent>
        </Dialog>

        {/* CSV Import Dialog */}
        <CSVImportDialog
          open={importDialogOpen}
          onOpenChange={setImportDialogOpen}
          entityType="deals"
          onImportComplete={() => {
            window.location.reload();
          }}
        />
      </>
  );
}
