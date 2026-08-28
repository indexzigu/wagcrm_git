import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  LinkedEntitySection,
  type LinkedEntityItem,
  type LinkedEntitySectionProps,
} from "./linked-entity-section";
import { Building2 } from "lucide-react";
import { LinkSearchDialog } from "./link-search-dialog";

// --- Types ---

export type LinkedPartner = {
  id: string;
  name: string;
  type?: string;
  status?: string;
  managerName?: string | null;
  category?: string | null;
};

type LinkedPartnersListProps = Omit<
  LinkedEntitySectionProps,
  "entities"
> & {
  partners: LinkedPartner[];
  onLinkPartner?: (partnerId: string) => Promise<void>;
  excludeIds?: string[];
};

export const partnerTypeLabels: Record<string, string> = {
  BRAND: "브랜드사",
  AGENCY: "광고대행사",
  MCN: "MCN",
  OTHER: "기타",
};

export const partnerStatusLabels: Record<string, string> = {
  ACTIVE: "활성",
  INACTIVE: "비활성",
  PENDING: "대기중",
};

// --- Component ---

export function LinkedPartnersList({
  partners,
  title,
  onLinkPartner,
  excludeIds,
  onLinkClick,
  ...props
}: LinkedPartnersListProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const linkedPartnerItems: LinkedEntityItem[] = partners.map((partner) => {
    const pType = partner.type ? partnerTypeLabels[partner.type] || partner.type : "";
    const pStatus = partner.status ? partnerStatusLabels[partner.status] || partner.status : "";
    
    return {
      id: partner.id,
      primaryLabel: partner.name,
      secondaryLabels: [],
      customNode: (
        <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5">
          <div className="flex w-full items-center gap-x-2 text-[11px] truncate">
            <Building2 className="size-3.5 text-muted-foreground shrink-0" />
            <span className="font-medium text-foreground truncate">
              {partner.name}
            </span>
            {pType && (
              <Badge variant="outline" size="compact" className="font-normal text-muted-foreground whitespace-nowrap shrink-0">
                {pType}
              </Badge>
            )}
            {pStatus && (
              <Badge variant="secondary" size="compact" className="font-normal shrink-0">
                {pStatus}
              </Badge>
            )}
          </div>
          {partner.managerName && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              담당자: {partner.managerName}
            </p>
          )}
        </div>
      ),
    };
  });

  return (
    <>
      <LinkedEntitySection
        title={title ?? `연결된 거래처 (${partners.length}곳)`}
        entities={linkedPartnerItems}
        onLinkClick={onLinkClick ?? (onLinkPartner ? () => setSearchOpen(true) : undefined)}
        {...props}
      />
      {onLinkPartner && (
        <LinkSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          entityType="partner"
          searchEndpoint="/api/search/partners"
          excludeIds={excludeIds}
          title="거래처 검색"
          placeholder="거래처명 검색"
          onSelect={async (item) => {
            await onLinkPartner(item.id);
            setSearchOpen(false);
          }}
        />
      )}
    </>
  );
}
