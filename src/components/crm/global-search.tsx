"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, SearchIcon, UsersIcon, BriefcaseIcon, Table2Icon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { getDealIdentityParts } from "@/lib/deal-display";
import {
  dealStatusLabels,
  campaignStatusLabels,
  partnerTypeLabels,
  type DealStatus,
  type CampaignStatus,
  type PartnerType,
} from "@/lib/crm-types";

interface SearchResults {
  partners: Array<{ id: string; name: string; type: string }>;
  sellers: Array<{ id: string; name: string; snsHandle: string; snsType: string }>;
  deals: Array<{
    id: string;
    dealName: string;
    brandName?: string | null;
    partnerName?: string | null;
    status: string;
  }>;
  campaigns: Array<{
    id: string;
    dealName: string;
    brandName?: string | null;
    partnerName?: string | null;
    sellerName: string;
    status: string;
  }>;
}

const EMPTY_RESULTS: SearchResults = {
  partners: [],
  sellers: [],
  deals: [],
  campaigns: [],
};

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResults>(EMPTY_RESULTS);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasResults =
    results.partners.length > 0 ||
    results.sellers.length > 0 ||
    results.deals.length > 0 ||
    results.campaigns.length > 0;

  // Debounced search
  const handleInputChange = React.useCallback((value: string) => {
    setQuery(value);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (value.trim().length < 2) {
      setResults(EMPTY_RESULTS);
      setIsOpen(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        if (res.ok) {
          const data: SearchResults = await res.json();
          setResults(data);
          setIsOpen(true);
        }
      } catch {
        // Silently fail on network errors
      } finally {
        setIsLoading(false);
      }
    }, 300);
  }, []);

  // Close dropdown on outside click
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cleanup debounce on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  function handleSelect(entityType: string, id: string) {
    setIsOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);

    switch (entityType) {
      case "partner":
        router.push(`/partners?selectedPartner=${id}`);
        break;
      case "seller":
        router.push(`/sellers?selectedSeller=${id}`);
        break;
      case "deal":
        router.push(`/deals?selected=${id}`);
        break;
      case "campaign":
        router.push(`/pipeline?selected=${id}`);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative hidden md:block">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        {isLoading && (
          <Loader2Icon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        <input
          type="text"
          aria-label="전체 검색"
          placeholder="전체 검색..."
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => {
            if (query.trim().length >= 2 && hasResults) {
              setIsOpen(true);
            }
          }}
          className={cn(
            "flex h-9 w-full min-w-[16rem] max-w-[25rem] rounded-lg border border-border bg-slate-50 pl-9 pr-9 text-sm shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-focus-ring"
          )}
        />
      </div>

      {isOpen && (
        <div className="absolute top-full left-0 z-50 mt-1 w-full min-w-[20rem] overflow-hidden rounded-lg border bg-popover shadow-overlay">
          <Command shouldFilter={false}>
            <CommandList>
              {!hasResults && !isLoading && (
                <CommandEmpty>검색 결과 없음</CommandEmpty>
              )}

              {results.partners.length > 0 && (
                <CommandGroup heading="거래처">
                  {results.partners.map((partner) => (
                    <CommandItem
                      key={`partner-${partner.id}`}
                      value={`partner-${partner.id}`}
                      onSelect={() => handleSelect("partner", partner.id)}
                    >
                      <UsersIcon className="size-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{partner.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground shrink-0 pl-2">
                        {partnerTypeLabels[partner.type as PartnerType] || partner.type}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.sellers.length > 0 && (
                <CommandGroup heading="셀러">
                  {results.sellers.map((seller) => (
                    <CommandItem
                      key={`seller-${seller.id}`}
                      value={`seller-${seller.id}`}
                      onSelect={() => handleSelect("seller", seller.id)}
                    >
                      <UsersIcon className="size-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <SellerIdentityInfo
                          sellerName={seller.name}
                          snsType={seller.snsType}
                          snsHandle={seller.snsHandle}
                          variant="compact"
                        />
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.deals.length > 0 && (
                <CommandGroup heading="딜">
                  {results.deals.map((deal) => (
                    <CommandItem
                      key={`deal-${deal.id}`}
                      value={`deal-${deal.id}`}
                      onSelect={() => handleSelect("deal", deal.id)}
                    >
                      <BriefcaseIcon className="size-4 text-muted-foreground shrink-0" />
                      <EntityIdentity
                        parts={getDealIdentityParts({
                          dealName: deal.dealName,
                          brandName: deal.brandName,
                          partnerName: deal.partnerName,
                        })}
                        className="max-w-[75%] truncate"
                      />
                      <span className="ml-auto text-xs text-muted-foreground shrink-0 pl-2">
                        {dealStatusLabels[deal.status as DealStatus] || deal.status}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.campaigns.length > 0 && (
                <CommandGroup heading="캠페인">
                  {results.campaigns.map((campaign) => (
                    <CommandItem
                      key={`campaign-${campaign.id}`}
                      value={`campaign-${campaign.id}`}
                      onSelect={() => handleSelect("campaign", campaign.id)}
                    >
                      <Table2Icon className="size-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                        <EntityIdentity
                          parts={getDealIdentityParts({
                            dealName: campaign.dealName,
                            brandName: campaign.brandName,
                            partnerName: campaign.partnerName,
                          })}
                          className="max-w-full"
                        />
                        <div className="text-[10px] text-muted-foreground truncate">
                          셀러: {campaign.sellerName}
                        </div>
                      </div>
                      <span className="ml-auto text-xs text-muted-foreground shrink-0 pl-2">
                        {campaignStatusLabels[campaign.status as CampaignStatus] || campaign.status}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
