"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  dealStatusLabels,
  salesChannelLabels,
  type DealStatus,
  type SalesChannel,
} from "@/lib/crm-types";
import {
  EntityIdentity,
  type EntityIdentityPart,
} from "@/components/crm/entity-identity";
import { getDealContextParts, getDealIdentityParts } from "@/lib/deal-display";
import { campaignFormSchema, SALES_CHANNELS } from "@/lib/validations/campaign";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { filterBySearchText } from "@/lib/search-filter";

// --- Types ---

export type CampaignCreationFormProps = {
  onSuccess?: () => void;
  onCancel?: () => void;
  /** 딜 상세에서 "신규 캠페인 생성" 시 사전 선택된 딜 ID */
  initialDealId?: string;
  /** 사전 선택된 딜 이름 (표시용) */
  initialDealName?: string;
};

type DealSearchResult = {
  id: string;
  dealName: string;
  brandName?: string;
  status: string;
  partnerId: string;
  partnerName: string;
};

type SellerSearchResult = {
  id: string;
  name: string;
  snsType: string;
  snsHandle: string;
  currentFollowers: number;
};

type DealOptionItem = {
  id: string;
  dealName: string;
  costPrice: number;
  sellingPrice: number;
  totalCommissionRate: number | null;
  isMain: boolean;
};

// --- Component ---

export function CampaignCreationForm({
  onSuccess,
  onCancel,
  initialDealId,
  initialDealName,
}: CampaignCreationFormProps) {
  // Form state
  const [dealId, setDealId] = useState(initialDealId ?? "");
  const [dealName, setDealName] = useState(initialDealName ?? "");
  const [dealContext, setDealContext] = useState<EntityIdentityPart[]>([]);
  const [sellerId, setSellerId] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [salesChannel, setSalesChannel] = useState<SalesChannel>("UNSPECIFIED");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Options state for selected deal
  const [dealOptions, setDealOptions] = useState<DealOptionItem[]>([]);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  const fetchDealOptions = useCallback(async (id: string, activeRef?: { current: boolean }) => {
    if (!activeRef || activeRef.current) {
      setLoadingOptions(true);
    }
    try {
      const res = await fetch(`/api/deals/${id}`);
      if (res.ok) {
        const data = await res.json();
        const optionsList: DealOptionItem[] = [];
        
        // 메인 딜 자체도 구성에 포함
        optionsList.push({
          id: data.id,
          dealName: data.dealName,
          costPrice: Number(data.costPrice || 0),
          sellingPrice: Number(data.sellingPrice || 0),
          totalCommissionRate: data.totalCommissionRate ? Number(data.totalCommissionRate) : null,
          isMain: true,
        });

        if (!activeRef || activeRef.current) {
          setDealContext(
            getDealContextParts({
              brandName: data.brandName ?? null,
              partnerName: data.partnerName ?? null,
            }),
          );
        }

        // 자식 옵션들 추가
        if (data.options && Array.isArray(data.options)) {
          data.options.forEach((opt: {
            id: string;
            dealName: string;
            costPrice?: number | string | null;
            sellingPrice?: number | string | null;
            totalCommissionRate?: number | string | null;
          }) => {
            optionsList.push({
              id: opt.id,
              dealName: opt.dealName,
              costPrice: Number(opt.costPrice || 0),
              sellingPrice: Number(opt.sellingPrice || 0),
              totalCommissionRate: opt.totalCommissionRate ? Number(opt.totalCommissionRate) : null,
              isMain: false,
            });
          });
        }

        if (!activeRef || activeRef.current) {
          setDealOptions(optionsList);
          // 기본적으로 메인 딜과 하위 옵션들 전체 체크
          setSelectedOptionIds(optionsList.map((o) => o.id));
        }
      } else {
        if (!activeRef || activeRef.current) {
          setDealOptions([]);
          setSelectedOptionIds([]);
          setDealContext([]);
        }
      }
    } catch {
      if (!activeRef || activeRef.current) {
        setDealOptions([]);
        setSelectedOptionIds([]);
        setDealContext([]);
      }
    } finally {
      if (!activeRef || activeRef.current) {
        setLoadingOptions(false);
      }
    }
  }, []);

  useEffect(() => {
    const activeRef = { current: true };
    const run = async () => {
      await Promise.resolve(); // Defer to microtask to prevent synchronous setState inside effect
      if (dealId) {
        await fetchDealOptions(dealId, activeRef);
      } else {
        if (activeRef.current) {
          setDealOptions([]);
          setSelectedOptionIds([]);
          setDealContext([]);
        }
      }
    };
    void run();
    return () => {
      activeRef.current = false;
    };
  }, [dealId, fetchDealOptions]);

  // Search state
  const [dealQuery, setDealQuery] = useState("");
  const [dealResults, setDealResults] = useState<DealSearchResult[]>([]);
  const [dealLoading, setDealLoading] = useState(false);
  const [dealDropdownOpen, setDealDropdownOpen] = useState(false);

  const [sellerQuery, setSellerQuery] = useState("");
  const [sellerResults, setSellerResults] = useState<SellerSearchResult[]>([]);
  const [sellerLoading, setSellerLoading] = useState(false);
  const [sellerDropdownOpen, setSellerDropdownOpen] = useState(false);

  // Form state
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Debounce refs
  const dealDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sellerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerDealSearch = useCallback((nextQuery: string) => {
    if (dealDebounceRef.current) {
      clearTimeout(dealDebounceRef.current);
      dealDebounceRef.current = null;
    }

    if (nextQuery.length < 2) return;

    dealDebounceRef.current = setTimeout(async () => {
      setDealLoading(true);
      try {
        const params = new URLSearchParams({ q: nextQuery });
        const res = await fetch(`/api/search/deals?${params.toString()}`);
        if (!res.ok) throw new Error("검색 실패");
        const data = await res.json();
        setDealResults(data.results ?? []);
      } catch {
        setDealResults([]);
      } finally {
        setDealLoading(false);
      }
    }, 300);

    return () => {
      if (dealDebounceRef.current) {
        clearTimeout(dealDebounceRef.current);
      }
    };
  }, []);

  const triggerSellerSearch = useCallback((nextQuery: string) => {
    if (sellerDebounceRef.current) {
      clearTimeout(sellerDebounceRef.current);
      sellerDebounceRef.current = null;
    }

    if (nextQuery.length < 2) return;

    sellerDebounceRef.current = setTimeout(async () => {
      setSellerLoading(true);
      try {
        const res = await fetch(`/api/sellers`);
        if (!res.ok) throw new Error("검색 실패");
        const data = await res.json();
        // Client-side filter by query (NFC-normalized + choseong search)
        const filtered = filterBySearchText(
          (data.sellers ?? []) as SellerSearchResult[],
          nextQuery,
          (seller) => [seller.name, seller.snsHandle],
        );
        setSellerResults(filtered.slice(0, 20));
      } catch {
        setSellerResults([]);
      } finally {
        setSellerLoading(false);
      }
    }, 300);

    return () => {
      if (sellerDebounceRef.current) {
        clearTimeout(sellerDebounceRef.current);
      }
    };
  }, []);

  // --- Handlers ---

  const handleDealSelect = useCallback((deal: DealSearchResult) => {
    setDealId(deal.id);
    setDealName(deal.dealName);
    setDealContext(getDealContextParts(deal));
    setDealQuery("");
    setDealResults([]);
    setDealDropdownOpen(false);
    setErrors((prev) => {
      const next = { ...prev };
      delete next.dealId;
      return next;
    });
  }, []);

  const handleSellerSelect = useCallback((seller: SellerSearchResult) => {
    setSellerId(seller.id);
    setSellerName(`${seller.name} @${seller.snsHandle}`);
    setSellerQuery("");
    setSellerResults([]);
    setSellerDropdownOpen(false);
    setErrors((prev) => {
      const next = { ...prev };
      delete next.sellerId;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    setErrors({});
    setServerError(null);

    const formData = {
      dealId,
      sellerId,
      salesChannel: salesChannel || undefined,
      startDate,
      endDate,
    };

    const result = campaignFormSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0]?.toString();
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);

    const campaignDeals = selectedOptionIds.map((id) => {
      const opt = dealOptions.find((o) => o.id === id);
      return {
        dealId: id,
        quantity: 0,
        actualSales: 0,
        feeRate: opt?.totalCommissionRate ?? null,
        costPrice: opt?.costPrice ?? 0,
        sellingPrice: opt?.sellingPrice ?? 0,
      };
    });

    const promise = fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dealId: result.data.dealId,
        sellerId: result.data.sellerId,
        salesChannel: result.data.salesChannel,
        startDate: result.data.startDate,
        endDate: result.data.endDate,
        baseNaverLink: "https://placeholder.example.com",
        campaignDeals,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const message =
          errorData?.error && typeof errorData.error === "string"
            ? errorData.error
            : "캠페인 저장에 실패했습니다. 다시 시도해주세요.";
        throw new Error(message);
      }
      return res.json();
    }).then((data) => {
      // Reset form
      setDealId(initialDealId ?? "");
      setDealName(initialDealName ?? "");
      setSellerId("");
      setSellerName("");
      setSalesChannel("UNSPECIFIED");
      setStartDate("");
      setEndDate("");
      setDealOptions([]);
      setSelectedOptionIds([]);

      onSuccess?.();
      return data;
    }).catch((err) => {
      console.log("CATCH ERR:", err, "MSG:", err.message);
      const isNetworkError = err.message === "Network error" || err.message === "Failed to fetch";
      setServerError(isNetworkError ? "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." : err.message);
      throw err;
    }).finally(() => {
      setSubmitting(false);
    });

    withMutationFeedback(promise).catch(() => {});

    await promise.catch(() => {});
  }, [dealId, sellerId, salesChannel, startDate, endDate, initialDealId, initialDealName, selectedOptionIds, dealOptions, onSuccess]);

  const isDealLocked = !!initialDealId;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 px-1 py-2">
        {serverError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {serverError}
          </div>
        )}

        {/* 딜 필드 */}
        <FormField label="딜" required error={errors.dealId}>
          {isDealLocked ? (
            <Input value={dealName || initialDealId} disabled className="bg-muted" />
          ) : (
            <div className="relative">
              <Input
                value={dealDropdownOpen ? dealQuery : dealName || dealQuery}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setDealQuery(nextValue);
                  setDealDropdownOpen(true);
                  if (!nextValue) {
                    setDealId("");
                    setDealName("");
                  }
                  if (nextValue.length < 2) {
                    setDealResults([]);
                    setDealLoading(false);
                    return;
                  }
                  triggerDealSearch(nextValue);
                }}
                onFocus={() => {
                  if (dealQuery.length >= 2 || dealResults.length > 0) {
                    setDealDropdownOpen(true);
                  }
                }}
                placeholder="딜명 또는 브랜드명으로 검색 (2자 이상)"
              />
              {dealName ? (
                <EntityIdentity
                  parts={getDealIdentityParts({
                    dealName,
                    brandName: dealContext.find((part) => part.label === "브랜드")?.value ?? null,
                    partnerName:
                      dealContext.find((part) => part.label === "거래처")?.value ?? null,
                  })}
                  className="mt-1 max-w-full"
                />
              ) : null}
              {dealDropdownOpen && (dealLoading || dealResults.length > 0 || dealQuery.length >= 2) && (
                <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-overlay">
                  {dealLoading ? (
                    <div className="flex items-center justify-center py-3">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">검색 중...</span>
                    </div>
                  ) : dealResults.length === 0 && dealQuery.length >= 2 ? (
                    <div className="px-3 py-3 text-sm text-muted-foreground">
                      검색 결과가 없습니다
                    </div>
                  ) : (
                    <ul className="max-h-48 overflow-y-auto py-1">
                      {dealResults.map((deal) => (
                        <li
                          key={deal.id}
                          className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
                          onClick={() => handleDealSelect(deal)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <EntityIdentity
                              parts={getDealIdentityParts(deal)}
                              className="min-w-0 flex-1 overflow-hidden"
                            />
                            <span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {dealStatusLabels[deal.status as DealStatus] ?? deal.status}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </FormField>

        {/* 딜 옵션 다중 선택 UI */}
        {dealId && (
          <div className="rounded-xl border border-border bg-slate-50/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground">
                판매 품목 구성 선택
              </Label>
              <span className="text-[10px] text-muted-foreground">
                {selectedOptionIds.length}개 선택됨
              </span>
            </div>

            {loadingOptions ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-xs text-muted-foreground">옵션 정보 로딩 중...</span>
              </div>
            ) : dealOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">등록된 상품 구성이 없습니다.</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {dealOptions.map((opt) => {
                  const isChecked = selectedOptionIds.includes(opt.id);
                  return (
                    <label
                      key={opt.id}
                      className={`flex items-start gap-3 rounded-lg border p-2.5 text-xs transition-[background-color,border-color,box-shadow] cursor-pointer ${
                        isChecked
                          ? "border-primary bg-primary/5 shadow-soft-sm"
                          : "border-border bg-white hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedOptionIds((prev) => [...prev, opt.id]);
                          } else {
                            if (selectedOptionIds.length <= 1) {
                              toast.warning("최소 1개의 품목 구성을 선택해야 합니다.");
                              return;
                            }
                            setSelectedOptionIds((prev) => prev.filter((id) => id !== opt.id));
                          }
                        }}
                        className="mt-0.5 rounded border-slate-300 text-primary focus:ring-focus-ring size-3.5"
                      />
                      <div className="flex-1 space-y-0.5 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`font-semibold ${opt.isMain ? "text-slate-800" : "text-slate-600 pl-2 border-l border-slate-200"}`}>
                            {opt.dealName}
                          </span>
                          {opt.isMain ? (
                            <span className="text-[9px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                              메인
                            </span>
                          ) : (
                            <span className="text-[9px] font-medium bg-sky-50 text-sky-600 px-1.5 py-0.5 rounded">
                              옵션
                            </span>
                          )}
                        </div>
                        <div className={`text-[10px] text-muted-foreground ${!opt.isMain && "pl-2.5"}`}>
                          판매가: {opt.sellingPrice.toLocaleString()}원
                          {opt.totalCommissionRate != null && ` · 수수료: ${opt.totalCommissionRate}%`}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 셀러 필드 */}
        <FormField label="셀러" required error={errors.sellerId}>
          <div className="relative">
            <Input
              value={sellerDropdownOpen ? sellerQuery : sellerName || sellerQuery}
              onChange={(e) => {
                const nextValue = e.target.value;
                setSellerQuery(nextValue);
                setSellerDropdownOpen(true);
                if (!nextValue) {
                  setSellerId("");
                  setSellerName("");
                }
                if (nextValue.length < 2) {
                  setSellerResults([]);
                  setSellerLoading(false);
                  return;
                }
                triggerSellerSearch(nextValue);
              }}
              onFocus={() => {
                if (sellerQuery.length >= 2 || sellerResults.length > 0) {
                  setSellerDropdownOpen(true);
                }
              }}
              placeholder="셀러명 또는 SNS 핸들로 검색 (2자 이상)"
            />
            {sellerDropdownOpen && (sellerLoading || sellerResults.length > 0 || sellerQuery.length >= 2) && (
              <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-overlay">
                {sellerLoading ? (
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">검색 중...</span>
                  </div>
                ) : sellerResults.length === 0 && sellerQuery.length >= 2 ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">
                    검색 결과가 없습니다
                  </div>
                ) : (
                  <ul className="max-h-48 overflow-y-auto py-1">
                    {sellerResults.map((seller) => (
                      <li
                        key={seller.id}
                        className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
                        onClick={() => handleSellerSelect(seller)}
                      >
                        <div className="font-medium">{seller.name}</div>
                        <div className="text-xs text-muted-foreground">
                          @{seller.snsHandle} · {seller.snsType}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </FormField>

        {/* 판매채널 */}
        <FormField label="판매채널" required error={errors.salesChannel}>
          <Select
            value={salesChannel}
            onValueChange={(value) => {
              setSalesChannel(value as SalesChannel);
              setErrors((prev) => {
                const next = { ...prev };
                delete next.salesChannel;
                return next;
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="판매채널 선택" />
            </SelectTrigger>
            <SelectContent>
              {SALES_CHANNELS.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {salesChannelLabels[channel]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {/* 시작일 & 종료일 */}
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="시작일" required error={errors.startDate}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setErrors((prev) => {
                  const next = { ...prev };
                  delete next.startDate;
                  return next;
                });
              }}
            />
          </FormField>
          <FormField label="종료일" required error={errors.endDate}>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setErrors((prev) => {
                  const next = { ...prev };
                  delete next.endDate;
                  return next;
                });
              }}
            />
          </FormField>
        </div>

        {/* 버튼 */}
        <div className="flex items-center justify-end gap-3 pt-2">
          {onCancel && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={submitting}
            >
              취소
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "저장 중..." : "캠페인 생성"}
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

// --- FormField Helper ---

function FormField({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
