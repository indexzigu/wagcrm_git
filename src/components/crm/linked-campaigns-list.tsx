import { useState } from "react";
import { campaignStatusLabels, type CampaignStatus } from "@/lib/crm-types";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";
import {
  LinkedEntitySection,
  type LinkedEntityItem,
  type LinkedEntitySectionProps,
} from "./linked-entity-section";
import { LinkSearchDialog } from "./link-search-dialog";

// --- Types ---

export type LinkedCampaign = {
  id: string;
  dealId: string;
  sellerId: string;
  dealName: string;
  sellerName: string;
  brandName?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status: string;
};

type LinkedCampaignsListProps = Omit<
  LinkedEntitySectionProps,
  "entities"
> & {
  campaigns: LinkedCampaign[];
  onLinkCampaign?: (campaignId: string) => Promise<void>;
  excludeDealId?: string;
};

// --- Component ---

export function LinkedCampaignsList({
  campaigns,
  title,
  onLinkCampaign,
  excludeDealId,
  onLinkClick,
  ...props
}: LinkedCampaignsListProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const linkedCampaignItems: LinkedEntityItem[] = campaigns.map((campaign) => {
    return {
      id: campaign.id,
      primaryLabel: `${campaign.dealName} - ${campaign.sellerName}`,
      secondaryLabels: [],
      customNode: (
        <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5">
          <div className="flex w-full items-center gap-x-2 text-[11px] truncate">
            {/* 캠페인명은 라벨 없이 딜명+셀러명으로 강하게 표시 */}
            <span className="font-semibold text-foreground truncate">
              {campaign.dealName} - {campaign.sellerName}
            </span>
            {campaign.brandName && (
              <div className="flex shrink-0 items-center gap-1.5 border-l border-border pl-2">
                <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal text-muted-foreground whitespace-nowrap">
                  브랜드
                </Badge>
                <span className="text-muted-foreground truncate">{campaign.brandName}</span>
              </div>
            )}
          </div>
          {(campaign.startDate || campaign.endDate) && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {campaign.startDate ? new Date(campaign.startDate).toLocaleDateString() : ""} ~ {campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : ""}
            </p>
          )}
        </div>
      ),
      statusNode: (
        <StatusBadge
          status={campaign.status as CampaignStatus}
          className="max-w-[80px] truncate text-[9px] px-1 h-4 font-semibold"
        />
      ),
      status: campaignStatusLabels[campaign.status as CampaignStatus] || campaign.status,
    };
  });

  return (
    <>
      <LinkedEntitySection
        title={title ?? `연결된 캠페인 (${campaigns.length}건)`}
        entities={linkedCampaignItems}
        onLinkClick={onLinkClick ?? (onLinkCampaign ? () => setSearchOpen(true) : undefined)}
        {...props}
      />
      {onLinkCampaign && (
        <LinkSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          entityType="campaign"
          searchEndpoint="/api/search/campaigns"
          searchParams={excludeDealId ? { excludeDealId } : undefined}
          title="연결할 캠페인 검색"
          placeholder="셀러명 또는 판매채널 검색"
          onSelect={async (item) => {
            await onLinkCampaign(item.id);
            setSearchOpen(false);
          }}
        />
      )}
    </>
  );
}
