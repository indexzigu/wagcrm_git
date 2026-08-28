"use client";

import * as React from "react";
import { Search, Loader2, AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDealContextLabel, getDealIdentityParts } from "@/lib/deal-display";
import { dealStatusLabels, type DealStatus } from "@/lib/crm-types";
import {
  EntityIdentity,
  type EntityIdentityPart,
} from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * LinkSearchDialog — 엔티티 연결 시 사용하는 공통 검색 다이얼로그.
 *
 * 일관된 UX를 제공하며, 어떤 엔티티를 연결하든 동일한 방식으로 작업할 수 있다.
 *
 * Requirements: 10.1~10.9
 */

export type SearchResultItem = {
  id: string;
  label: string;
  sublabel?: string;
  identityParts?: EntityIdentityPart[];
  metadata?: Record<string, string>;
};

export type LinkSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "deal" | "campaign" | "partner" | "seller" | "task";
  /** 검색 결과에서 제외할 엔티티 ID 목록 */
  excludeIds?: string[];
  /** 검색 API 엔드포인트 */
  searchEndpoint: string;
  /** API에 함께 전달할 추가 검색 파라미터 */
  searchParams?: Record<string, string | undefined>;
  /** 선택 완료 콜백 */
  onSelect: (entity: SearchResultItem) => void;
  title?: string;
  placeholder?: string;
  simpleDealDisplay?: boolean;
};

const entityTypeDescriptions: Record<
  LinkSearchDialogProps["entityType"],
  string
> = {
  deal: "연결할 딜을 검색하고 선택합니다.",
  campaign: "연결할 캠페인을 검색하고 선택합니다.",
  partner: "연결할 거래처를 검색하고 선택합니다.",
  seller: "연결할 셀러를 검색하고 선택합니다.",
  task: "연결할 테스크를 검색하고 선택합니다.",
};

export function normalizeSearchResults(
  entityType: LinkSearchDialogProps["entityType"],
  rawResults: Array<Record<string, unknown>>,
): SearchResultItem[] {
  switch (entityType) {
    case "deal":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.dealName ?? ""),
        sublabel: formatDealContextLabel({
          brandName: typeof item.brandName === "string" ? item.brandName : null,
          partnerName: typeof item.partnerName === "string" ? item.partnerName : null,
        }),
        identityParts: getDealIdentityParts({
          dealName: typeof item.dealName === "string" ? item.dealName : null,
          brandName: typeof item.brandName === "string" ? item.brandName : null,
          partnerName: typeof item.partnerName === "string" ? item.partnerName : null,
        }),
        metadata: {
          status:
            dealStatusLabels[item.status as DealStatus] ??
            String(item.status ?? ""),
        },
      }));
    case "campaign":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.sellerName ?? ""),
        sublabel: [item.dealName, item.salesChannel].filter(Boolean).join(" - ") || undefined,
        metadata: {
          status: String(item.status ?? ""),
        },
      }));
    case "partner":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.name ?? ""),
        sublabel: String(item.type ?? "") || undefined,
        metadata: {
          type: String(item.type ?? ""),
          status: String(item.status ?? ""),
          companyRole: String(item.companyRole ?? ""),
          deals: JSON.stringify(item.deals ?? []),
        },
      }));
    case "seller":
      return rawResults.map((item) => {
        const nameStr = String(item.name ?? "");
        const aliasStr = item.alias && typeof item.alias === "string" ? item.alias : null;
        return {
          id: String(item.id),
          label: aliasStr ? aliasStr : nameStr,
          sublabel: [item.snsType, item.snsHandle].filter(Boolean).join(" - ") || undefined,
          metadata: {
            snsType: String(item.snsType ?? ""),
            snsHandle: String(item.snsHandle ?? ""),
            ...(typeof item.fitLevel === "string" ? { fitLevel: item.fitLevel } : {}),
            ...(aliasStr ? { alias: aliasStr } : {}),
            ...(item.agency && typeof item.agency === "object" && (item.agency as Record<string, unknown>).name
              ? { agencyName: String((item.agency as Record<string, unknown>).name) }
              : {}),
          },
        };
      });
    case "task":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.title ?? item.sellerName ?? ""),
        sublabel: String(item.status ?? "") || undefined,
        metadata: {
          status: String(item.status ?? ""),
        },
      }));
    default:
      return [];
  }
}

export function LinkSearchDialog({
  open,
  onOpenChange,
  entityType,
  excludeIds = [],
  searchEndpoint,
  searchParams,
  onSelect,
  title = "엔티티 검색",
  placeholder = "검색어를 입력하세요 (2자 이상)",
  simpleDealDisplay = false,
}: LinkSearchDialogProps) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResultItem[]>([]);
  const [selectedItem, setSelectedItem] = React.useState<SearchResultItem | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasSearched, setHasSearched] = React.useState(false);
  const [initialResults, setInitialResults] = React.useState<SearchResultItem[]>([]);
  const [initialLoading, setInitialLoading] = React.useState(false);

  const excludeIdsKey = React.useMemo(() => excludeIds.join(","), [excludeIds]);
  const searchParamEntries = React.useMemo(
    () =>
      Object.entries(searchParams ?? {}).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
      ),
    [searchParams],
  );

  const inputRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const resetState = React.useCallback(() => {
    setQuery("");
    setResults([]);
    setSelectedItem(null);
    setLoading(false);
    setError(null);
    setHasSearched(false);
    setInitialResults([]);
    setInitialLoading(false);
  }, []);

  // Fetch initial list (최근 등록순) when dialog opens
  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    async function fetchInitialList() {
      setInitialLoading(true);
      try {
        const params = new URLSearchParams();
        searchParamEntries.forEach(([key, value]) => {
          params.set(key, value);
        });
        if (excludeIdsKey) {
          params.set("excludeIds", excludeIdsKey);
        }

        const response = await fetch(
          `${searchEndpoint}?${params.toString()}`,
          { signal: controller.signal },
        );

        if (!response.ok) throw new Error("목록을 불러오지 못했습니다.");

        const data = await response.json();
        if (!cancelled) {
          const items = normalizeSearchResults(
            entityType,
            ((data.results ?? []) as Array<Record<string, unknown>>).slice(0, 20),
          );
          setInitialResults(items);
        }
      } catch (err) {
        if (!cancelled && err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    }

    void fetchInitialList();
    const timer = setTimeout(() => inputRef.current?.focus(), 100);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, searchEndpoint, excludeIdsKey, entityType, searchParamEntries]);

  const triggerSearch = React.useCallback((nextQuery: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (nextQuery.length < 2) return;

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: nextQuery });
        searchParamEntries.forEach(([key, value]) => {
          params.set(key, value);
        });
        if (excludeIdsKey) {
          params.set("excludeIds", excludeIdsKey);
        }

        const response = await fetch(`${searchEndpoint}?${params.toString()}`);

        if (!response.ok) {
          throw new Error("검색에 실패했습니다.");
        }

        const data = await response.json();
        const items = normalizeSearchResults(
          entityType,
          ((data.results ?? []) as Array<Record<string, unknown>>).slice(0, 20),
        );
        setResults(items);
        setHasSearched(true);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "검색에 실패했습니다."
        );
        setResults([]);
        setHasSearched(true);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [searchEndpoint, excludeIdsKey, entityType, searchParamEntries]);

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (nextOpen && !open) {
      resetState();
    }
    if (!nextOpen && abortRef.current) {
      abortRef.current.abort();
    }
    onOpenChange(nextOpen);
  };

  // Determine which items to display
  const displayItems = hasSearched ? results : initialResults;

  const handleConfirm = () => {
    if (selectedItem) {
      onSelect(selectedItem);
      onOpenChange(false);
    }
  };

  const handleItemClick = (item: SearchResultItem) => {
    setSelectedItem(item);
  };

  const renderDealItem = (item: SearchResultItem) => {
    const status = item.metadata?.status;

    return (
      <div className="flex items-center justify-between gap-3">
        {simpleDealDisplay && entityType === "deal" ? (
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
            <span className="font-bold text-slate-900 text-sm truncate">
              {item.label}
            </span>
            {item.identityParts?.find(p => p.label === "브랜드") && (
              <span className="inline-flex min-w-0 items-center gap-1 shrink-0">
                <span className="inline-flex items-center rounded-sm border px-1 py-0 text-[9px] font-medium text-muted-foreground border-slate-200">
                  브랜드
                </span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {item.identityParts.find(p => p.label === "브랜드")?.value}
                </span>
              </span>
            )}
          </div>
        ) : simpleDealDisplay ? (
          <div className="min-w-0 flex-1 overflow-hidden font-bold text-slate-900 text-sm">
            {item.label}
          </div>
        ) : (
          <EntityIdentity
            parts={item.identityParts ?? [{ label: "딜", value: item.label }]}
            className="min-w-0 flex-1 overflow-hidden"
          />
        )}
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {status && (
            <span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {status}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderSellerItem = (item: SearchResultItem) => {
    const snsType = item.metadata?.snsType;
    const snsHandle = item.metadata?.snsHandle;
    const fitLevel = item.metadata?.fitLevel;

    return (
      <SellerIdentityInfo
        sellerName={item.label}
        snsType={snsType || ""}
        snsHandle={snsHandle || ""}
        fitLevel={fitLevel}
        variant="compact"
      />
    );
  };

  const renderPartnerItem = (item: SearchResultItem) => {
    const meta = item.metadata || {};
    
    // 영업/운영 관점에서 필요한 정보: 역할, 상태, 연동된 딜
    let deals: Array<{ id: string; dealName: string }> = [];
    if (meta.deals) {
      try {
        deals = JSON.parse(meta.deals);
      } catch {
        // ignore
      }
    }

    const roleBadge = item.sublabel || meta.companyRole || "기타";

    return (
      <div className="flex flex-col gap-1.5 w-full py-0.5">
        {/* 1행: 유형, 이름, 상태 */}
        <div className="flex items-center gap-3 w-full">
          <div className="w-[55px] shrink-0 text-left">
            <span className="text-[10px] font-bold text-slate-500">
              {roleBadge.toUpperCase()}
            </span>
          </div>

          <div className="flex min-w-0 flex-1 items-center">
            <span className="font-bold text-slate-900 text-[13px] truncate leading-tight">
              {item.label}
            </span>
          </div>
          
          {meta.status && (
            <div className="shrink-0 text-right ml-2">
              <span className="rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500">
                {meta.status}
              </span>
            </div>
          )}
        </div>

        {/* 2행: 연동된 딜 */}
        {deals.length > 0 && (
          <div className="flex flex-wrap gap-1 pl-[67px]">
            {deals.map(d => (
              <span key={d.id} className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                {d.dealName}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-md flex flex-col max-h-[90vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {entityTypeDescriptions[entityType]}
          </DialogDescription>
        </DialogHeader>

        {/* Search Input */}
        <div className="relative shrink-0">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              const nextValue = e.target.value;
              setQuery(nextValue);
              setSelectedItem(null);
              if (nextValue.length < 2) {
                setResults([]);
                setHasSearched(false);
                setError(null);
                setLoading(false);
                return;
              }
              triggerSearch(nextValue);
            }}
            placeholder={placeholder}
            className="pl-8"
          />
        </div>

        {/* Results Area — 이 flex-1 래퍼 자신이 스크롤러다. Radix ScrollArea 대신
            네이티브 스크롤로 바꾸는 것인데, 안쪽 자식에 h-full 을 주면 flex 로 잡힌
            부모 높이에 대해 height:100% 가 해소되지 않아 콘텐츠 높이로 부풀고
            overflow-hidden 이 그걸 잘라 "잘렸는데 스크롤바 없는" 상태가 된다(PR #57
            근본원인 재현). flex 자식 자신에 overflow-y-auto 를 얹으면 flex 가 높이를
            캡하고 네이티브 스크롤이 그 안에서 동작한다. scrollbar-gutter 는 입력마다
            결과 수가 바뀔 때 스크롤바 등장으로 인한 폭 흔들림을 막는다. */}
        <div className="flex-1 overflow-y-auto min-h-[200px] [scrollbar-gutter:stable]">
          {(loading || initialLoading) && (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {loading ? "검색 중..." : "불러오는 중..."}
              </span>
            </div>
          )}

          {error && !loading && !initialLoading && (
            <div className="flex flex-col items-center justify-center h-[200px] gap-2">
              <AlertCircle className="size-5 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {!loading && !initialLoading && !error && hasSearched && results.length === 0 && (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <p className="text-sm text-muted-foreground">
                검색 결과가 없습니다
              </p>
            </div>
          )}

          {!loading && !initialLoading && !error && displayItems.length > 0 && (
            <div className="flex flex-col gap-1 p-1">
              {displayItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleItemClick(item)}
                  className={cn(
                    "w-full px-3 py-2 text-left text-sm transition-colors",
                    "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    selectedItem?.id === item.id
                      ? "bg-primary/10 border border-primary/30 ring-1 ring-primary/20 rounded-md"
                      : entityType === "partner"
                      ? "border-b border-transparent border-b-slate-200 last:border-b-transparent rounded-none"
                      : "border border-transparent rounded-md"
                  )}
                >
                  {entityType === "deal" ? (
                    renderDealItem(item)
                  ) : entityType === "seller" ? (
                    renderSellerItem(item)
                  ) : entityType === "partner" ? (
                    renderPartnerItem(item)
                  ) : (
                    <>
                      <div className="font-medium">{item.label}</div>
                      {item.sublabel && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {item.sublabel}
                        </div>
                      )}
                      {item.metadata && Object.keys(item.metadata).length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {Object.entries(item.metadata).map(([key, value]) => (
                            <Badge key={key} variant="secondary">
                              {value}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </button>
              ))}
            </div>
          )}

          {!loading && !initialLoading && !error && !hasSearched && displayItems.length === 0 && (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <p className="text-sm text-muted-foreground">
                등록된 항목이 없습니다
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            취소
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedItem}
          >
            선택 확인
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
