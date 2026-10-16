"use client";

import * as React from "react";
import { Search, AlertCircle, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDealContextLabel, getDealIdentityParts } from "@/lib/deal-display";
import {
  campaignStatusLabels,
  dealStatusLabels,
  partnerStatusLabel,
  taskStatusLabels,
  partnerTypeLabels,
  salesChannelLabels,
  snsTypeLabels,
} from "@/lib/crm-types";
import { displayLabel, UNKNOWN_NAME } from "@/lib/display-label";
import { formatDate } from "@/lib/format";

/**
 * 영문 상태 코드를 화면에 그대로 찍지 않는다 — 상태 칸이라 표에 없는 코드는 「알 수 없음」(P2 ③, 공용 규칙
 * `displayLabel`). 값이 아예 없으면 빈 문자열이라 호출부가 칸을 숨긴다(`|| undefined`·`meta.status &&`).
 */
function labelOf(table: Readonly<Record<string, string>>, value: unknown): string {
  const raw = String(value ?? "");
  return raw ? displayLabel(table, raw, UNKNOWN_NAME) : "";
}
import { type EntityIdentityPart } from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { FormDialogFrame } from "@/components/crm/form-dialog-frame";
import { Input } from "@/components/ui/input";
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

export type LinkSearchMode = "select" | "link";

export type LinkSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "deal" | "campaign" | "partner" | "seller" | "task";
  /**
   * select = 한 칸을 채우거나 바꾸는 창(제목 「딜 선택」, 확인 「선택」) · link = 목록에 하나 더 잇는 창
   * (「딜 연결」/「연결」). 제목·설명·검색 안내는 이 값과 entityType 에서 만든다 — 호출처마다 제목을
   * 따로 적던 시절 같은 창이 12가지 이름으로 불렸다(2026-10-16).
   */
  mode?: LinkSearchMode;
  /** 지금 연결돼 있는 항목 — 「현재」로 표시하고 그 항목으로는 확인을 막는다. */
  currentId?: string;
  /** 검색 결과에서 제외할 엔티티 ID 목록 */
  excludeIds?: string[];
  /** 검색 API 엔드포인트 */
  searchEndpoint: string;
  /** API에 함께 전달할 추가 검색 파라미터 */
  searchParams?: Record<string, string | undefined>;
  /** 선택 완료 콜백 */
  onSelect: (entity: SearchResultItem) => void;
  /** 기본값은 mode·entityType 에서 만든다 — 특별한 이유가 없으면 넘기지 않는다. */
  title?: string;
  placeholder?: string;
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
          status: labelOf(dealStatusLabels, item.status),
          createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        },
      }));
    case "campaign":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.sellerName ?? ""),
        // 판매채널·거래처 유형·SNS 는 코드값이라 라벨 표를 거친다(종전엔 OWN_MALL 등이 그대로 보였다).
        sublabel:
          [item.dealName, item.salesChannel ? displayLabel(salesChannelLabels, String(item.salesChannel)) : null]
            .filter(Boolean)
            .join(" - ") || undefined,
        metadata: {
          status: labelOf(campaignStatusLabels, item.status),
        },
      }));
    case "partner":
      return rawResults.map((item) => ({
        id: String(item.id),
        label: String(item.name ?? ""),
        sublabel: item.type ? displayLabel(partnerTypeLabels, String(item.type)) : undefined,
        metadata: {
          type: String(item.type ?? ""),
          status: partnerStatusLabel(typeof item.status === "string" ? item.status : null),
          companyRole: String(item.companyRole ?? ""),
          createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
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
          sublabel:
            [item.snsType ? displayLabel(snsTypeLabels, String(item.snsType)) : null, item.snsHandle]
              .filter(Boolean)
              .join(" - ") || undefined,
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
        sublabel: labelOf(taskStatusLabels, item.status) || undefined,
        metadata: {
          status: labelOf(taskStatusLabels, item.status),
        },
      }));
    default:
      return [];
  }
}

const ENTITY_NOUN: Record<LinkSearchDialogProps["entityType"], string> = {
  deal: "딜",
  campaign: "캠페인",
  partner: "거래처",
  seller: "셀러",
  task: "테스크",
};

/** 한 칸을 채우거나 바꾸는 창 = 「○○ 선택」, 목록에 하나 더 잇는 창 = 「○○ 연결」(2026-10-16 문구 통일). */
function dialogCopy(entityType: LinkSearchDialogProps["entityType"], mode: LinkSearchMode) {
  const noun = ENTITY_NOUN[entityType];
  const verb = mode === "link" ? "연결" : "선택";
  // 설명문은 두지 않는다 — 제목·검색 안내·힌트와 같은 말의 되풀이였다(ss-ux 검토 2026-10-16).
  return {
    title: `${noun} ${verb}`,
    // 딜 검색 API 는 딜 이름·브랜드명으로 찾는다(/api/search/deals — 거래처 이름은 대상 아님).
    placeholder: entityType === "deal" ? "딜 또는 브랜드 이름으로 검색" : `${noun} 이름으로 검색`,
    confirmLabel: verb,
  };
}

const INITIAL_LIMIT = 20;
/** 딜·거래처는 고를 때 최근 등록순이 도움이 된다(오너 요청 2026-10-16) — 행에도 등록일을 보인다. */
const SORT_BY_CREATED = new Set<LinkSearchDialogProps["entityType"]>(["deal", "partner"]);

export function LinkSearchDialog({
  open,
  onOpenChange,
  entityType,
  mode = "select",
  currentId,
  excludeIds = [],
  searchEndpoint,
  searchParams,
  onSelect,
  title,
  placeholder,
}: LinkSearchDialogProps) {
  const copy = dialogCopy(entityType, mode);
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

  // Fetch initial list (최근순) when dialog opens
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
        if (SORT_BY_CREATED.has(entityType)) params.set("sort", "created");
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
            ((data.results ?? []) as Array<Record<string, unknown>>).slice(0, INITIAL_LIMIT),
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
        if (SORT_BY_CREATED.has(entityType)) params.set("sort", "created");
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
          ((data.results ?? []) as Array<Record<string, unknown>>).slice(0, INITIAL_LIMIT),
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

  // 닫을 때 비운다 — 부모가 open 을 제어하므로 「열릴 때」 분기는 닿지 않아, 확인 뒤 다시 열면
  // 이전 선택·검색어가 남아 있었다(코드 리뷰 2026-10-16).
  const close = () => {
    abortRef.current?.abort();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    resetState();
    onOpenChange(false);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    close();
  };

  // Determine which items to display
  const displayItems = hasSearched ? results : initialResults;
  const isBusy = loading || initialLoading;
  // 이미 연결된 항목을 다시 고르는 것은 아무것도 바꾸지 않는다 — 확인 버튼을 막아 「바뀐 줄」 착각을 없앤다.
  const selectedIsCurrent = !!selectedItem && selectedItem.id === currentId;

  // 더블클릭 확정은 두지 않는다 — 이 창의 다수 호출처가 고르는 즉시 저장(연결·딜 변경)하므로
  // 밀집 목록에서의 오조작을 확인 버튼 한 번으로 막는다(ss-ux 검토 P1, 2026-10-16).
  const handleConfirm = () => {
    if (!selectedItem || selectedItem.id === currentId) return;
    onSelect(selectedItem);
    close();
  };

  const hint = isBusy
    ? " "
    : hasSearched
      ? results.length === 0
        ? "\u00a0" // 가운데 「검색 결과 없음」과 같은 말을 되풀이하지 않는다
        : results.length >= INITIAL_LIMIT
        ? `상위 ${INITIAL_LIMIT}건 · 더 좁혀 입력하면 정확해집니다`
        : `검색 결과 ${results.length}건`
      : `${SORT_BY_CREATED.has(entityType) ? "최근 등록" : "최근"} ${INITIAL_LIMIT}건 · 2글자 이상 입력하면 전체에서 찾습니다`;

  // 딜·거래처 행은 한 줄이다 — 줄바꿈 없이 이름(말줄임) · 보조 정보 · 등록일. 상태 칩은 두지 않는다
  // (고를 때 판단에 쓰이지 않는다 — 오너 2026-10-16). 넘친 이름은 마우스를 올리면 전체가 보인다.
  const renderOneLine = (
    item: SearchResultItem,
    currentChip: React.ReactNode,
    middle: React.ReactNode,
  ) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 shrink truncate text-sm font-semibold text-foreground" title={item.label}>
        {item.label}
      </span>
      {currentChip}
      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">{middle}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="등록일">
        {formatDate(item.metadata?.createdAt)}
      </span>
    </div>
  );

  const renderDealItem = (item: SearchResultItem, currentChip: React.ReactNode) =>
    renderOneLine(
      item,
      currentChip,
      item.sublabel ? (
        <span className="truncate text-xs text-muted-foreground" title={item.sublabel}>
          {item.sublabel}
        </span>
      ) : null,
    );

  const renderSellerItem = (item: SearchResultItem, currentChip: React.ReactNode) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <SellerIdentityInfo
        sellerName={item.label}
        snsType={item.metadata?.snsType || ""}
        snsHandle={item.metadata?.snsHandle || ""}
        fitLevel={item.metadata?.fitLevel}
        variant="compact"
      />
      {currentChip}
    </div>
  );

  const renderPartnerItem = (item: SearchResultItem, currentChip: React.ReactNode) => {
    let deals: Array<{ id: string; dealName: string }> = [];
    if (item.metadata?.deals) {
      try {
        deals = JSON.parse(item.metadata.deals);
      } catch {
        // metadata.deals 는 normalizeSearchResults 가 JSON.stringify 로 만든다 — 깨질 경로가 없다.
      }
    }
    const dealText = deals.map((d) => d.dealName).join(", ");
    return renderOneLine(
      item,
      currentChip,
      <>
        {item.sublabel ? <ResultChip size="sm">{item.sublabel}</ResultChip> : null}
        {dealText ? (
          <span className="truncate text-xs text-muted-foreground" title={dealText}>
            {dealText}
          </span>
        ) : null}
      </>,
    );
  };

  const renderGenericItem = (item: SearchResultItem, currentChip: React.ReactNode) => {
    // 상태는 normalizeSearchResults 가 이미 라벨 표를 거친 값이다(labelOf).
    const status = item.metadata?.status;
    return (
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{item.label}</span>
            {currentChip}
          </div>
          {item.sublabel ? (
            <span className="truncate text-xs text-muted-foreground">{item.sublabel}</span>
          ) : null}
        </div>
        {status ? <ResultChip>{status}</ResultChip> : null}
      </div>
    );
  };

  const renderItem = (item: SearchResultItem) => {
    // 「현재」는 이름 바로 옆 — 오른쪽 상태 칩 열을 밀지 않는다.
    const currentChip = item.id === currentId ? <ResultChip>현재</ResultChip> : null;
    switch (entityType) {
      case "deal":
        return renderDealItem(item, currentChip);
      case "seller":
        return renderSellerItem(item, currentChip);
      case "partner":
        return renderPartnerItem(item, currentChip);
      default:
        return renderGenericItem(item, currentChip);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <FormDialogFrame
        title={title ?? copy.title}
        aria-describedby={undefined}
        heightClassName="h-[min(36rem,85vh)]"
        bodyClassName="px-4 py-3"
        toolbar={
          <div className="flex flex-col gap-1.5">
            <div className="relative">
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
                placeholder={placeholder ?? copy.placeholder}
                className="pl-8"
              />
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">{hint}</p>
          </div>
        }
        footer={
          <>
            <Button variant="outline" size="sm" onClick={close}>
              취소
            </Button>
            <Button size="sm" onClick={handleConfirm} disabled={!selectedItem || selectedIsCurrent}>
              {copy.confirmLabel}
            </Button>
          </>
        }
      >
        {/* 창 높이가 고정이라 불러오는 중·빈 목록·결과가 바뀌어도 중앙 정렬된 창이 움직이지 않는다
            (P8 Layout Stability). 불러오는 중은 결과 행 모양의 뼈대로 보인다(styleseed 3). */}
        {isBusy && (
          <div className="flex flex-col gap-1.5" role="status" aria-busy="true" aria-label={loading ? "검색 중" : "불러오는 중"}>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        )}

        {error && !isBusy && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <AlertCircle className="size-5 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {!isBusy && !error && displayItems.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {hasSearched ? "검색 결과 없음" : "등록된 항목 없음"}
            </p>
          </div>
        )}

        {!isBusy && !error && displayItems.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {displayItems.map((item) => {
              const isSelected = selectedItem?.id === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedItem(item)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    isSelected
                      ? "border-primary/40 bg-primary/[0.06]"
                      : "border-transparent hover:bg-muted",
                  )}
                >
                  {renderItem(item)}
                  <Check
                    aria-hidden="true"
                    className={cn("size-4 shrink-0 text-primary", isSelected ? "opacity-100" : "opacity-0")}
                  />
                </button>
              );
            })}
          </div>
        )}
      </FormDialogFrame>
    </Dialog>
  );
}

/** 행 오른쪽·이름 옆의 중립 칩(상태·유형·「현재」) — 판단 hue 를 싣지 않는다(P8 §4 범주는 무채색). */
function ResultChip({ children, size = "xs" }: { children: React.ReactNode; size?: "xs" | "sm" }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600",
        size === "sm" ? "text-xs" : "text-[10px]",
      )}
    >
      {children}
    </span>
  );
}
