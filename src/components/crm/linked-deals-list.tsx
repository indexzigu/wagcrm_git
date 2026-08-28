import { useState } from "react";
import { getDealIdentityParts } from "@/lib/deal-display";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { dealStatusLabels, type DealStatus } from "@/lib/crm-types";
import {
  LinkedEntitySection,
  type LinkedEntityItem,
  type LinkedEntitySectionProps,
} from "./linked-entity-section";
import { LinkSearchDialog } from "./link-search-dialog";

// --- Types ---

export type LinkedDeal = {
  id: string;
  dealName: string;
  brandName?: string | null;
  partnerName?: string | null;
  status: string;
  createdAt?: string;
};

type LinkedDealsListProps = Omit<
  LinkedEntitySectionProps,
  "entities"
> & {
  deals: LinkedDeal[];
  onLinkDeal?: (dealId: string) => Promise<void>;
  excludeIds?: string[];
};

// --- Component ---

export function LinkedDealsList({
  deals,
  title,
  onLinkDeal,
  excludeIds,
  onLinkClick,
  ...props
}: LinkedDealsListProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const linkedDealItems: LinkedEntityItem[] = deals.map((deal) => {
    const otherParts = getDealIdentityParts({
      dealName: deal.dealName,
      brandName: deal.brandName ?? undefined,
      partnerName: deal.partnerName ?? undefined,
    }).filter((part) => part.label !== "딜");

    return {
      id: deal.id,
      primaryLabel: deal.dealName,
      secondaryLabels: [],
      customNode: (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] min-w-0 truncate">
          <span className="font-semibold text-foreground truncate max-w-[200px]">
            {deal.dealName}
          </span>
          {otherParts.length > 0 && (
            <EntityIdentity parts={otherParts} variant="compact" />
          )}
        </div>
      ),
      status: dealStatusLabels[deal.status as DealStatus] || deal.status,
      date: deal.createdAt,
    };
  });

  return (
    <>
      <LinkedEntitySection
        title={title ?? `연결된 딜 (${deals.length}건)`}
        entities={linkedDealItems}
        onLinkClick={onLinkClick ?? (onLinkDeal ? () => setSearchOpen(true) : undefined)}
        {...props}
      />
      {onLinkDeal && (
        <LinkSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          entityType="deal"
          searchEndpoint="/api/search/deals"
          excludeIds={excludeIds}
          title="연결할 딜 검색"
          placeholder="딜명 또는 브랜드명 검색"
          onSelect={async (item) => {
            await onLinkDeal(item.id);
            setSearchOpen(false);
          }}
        />
      )}
    </>
  );
}
