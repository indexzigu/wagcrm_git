import { useState } from "react";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import {
  LinkedEntitySection,
  type LinkedEntityItem,
  type LinkedEntitySectionProps,
} from "./linked-entity-section";
import { LinkSearchDialog } from "./link-search-dialog";

// --- Types ---

export type LinkedSeller = {
  id: string;
  name: string;
  socialNetworks?: { network: string; handle: string; url: string }[];
  followerCount?: number | null;
  fitLevel?: string | null;
  partnerName?: string;
  snsType?: string | null;
  snsHandle?: string | null;
  followers?: number;
};

type LinkedSellersListProps = Omit<
  LinkedEntitySectionProps,
  "entities"
> & {
  sellers: LinkedSeller[];
  onLinkSeller?: (sellerId: string) => Promise<void>;
  excludeIds?: string[];
};

// --- Component ---

export function LinkedSellersList({
  sellers,
  title,
  onLinkSeller,
  excludeIds,
  onLinkClick,
  ...props
}: LinkedSellersListProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const linkedSellerItems: LinkedEntityItem[] = sellers.map((seller) => {
    return {
      id: seller.id,
      primaryLabel: seller.name,
      secondaryLabels: seller.partnerName ? [seller.partnerName] : [],
      customNode: (
        <SellerIdentityInfo
          sellerName={seller.name}
          snsType={seller.snsType ?? seller.socialNetworks?.[0]?.network ?? null}
          snsHandle={seller.snsHandle ?? seller.socialNetworks?.[0]?.handle ?? null}
          followers={seller.followers ?? seller.followerCount ?? null}
          fitLevel={seller.fitLevel ?? null}
          variant="compact"
        />
      ),
    };
  });

  return (
    <>
      <LinkedEntitySection
        title={title ?? `연결된 셀러 (${sellers.length}명)`}
        entities={linkedSellerItems}
        onLinkClick={onLinkClick ?? (onLinkSeller ? () => setSearchOpen(true) : undefined)}
        {...props}
      />
      {onLinkSeller && (
        <LinkSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          entityType="seller"
          searchEndpoint="/api/search/sellers"
          excludeIds={excludeIds}
          title="연결할 셀러 검색"
          placeholder="셀러명 검색"
          onSelect={async (item) => {
            await onLinkSeller(item.id);
            setSearchOpen(false);
          }}
        />
      )}
    </>
  );
}
