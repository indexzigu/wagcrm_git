"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link2 } from "lucide-react";
import { dealStatusLabels, type DealStatus } from "@/lib/crm-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DealLinkSectionProps = {
  dealId: string | null;
  dealName: string | null;
  brandName: string | null;
  partnerName?: string | null;
  dealStatus: string | null;
  onLinkDeal?: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DealLinkSection({
  dealId,
  dealName,
  brandName,
  partnerName,
  dealStatus,
  onLinkDeal,
}: DealLinkSectionProps) {
  const dealCount = dealId ? 1 : 0;

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-white/90 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            연결된 딜 ({dealCount}건)
          </h3>
          {dealStatus && (
            <Badge className="bg-slate-100 text-slate-700 text-[10px] font-medium px-2 py-0 h-5">
              {dealStatusLabels[dealStatus as DealStatus] ?? dealStatus}
            </Badge>
          )}
        </div>
        {onLinkDeal && (
          <Button
            variant="outline"
            className="h-6 text-[10px] px-2 py-0 gap-0.5 rounded-md border-border/70 text-muted-foreground inline-flex items-center"
            onClick={onLinkDeal}
          >
            <Link2 className="size-2.5" />
            <span>연결</span>
          </Button>
        )}
      </div>

      {dealId ? (
        <div className="group rounded-xl border border-border/50 bg-white hover:bg-slate-50/50 transition-colors p-3 flex items-center justify-between">
          <div className="flex items-center min-w-0 gap-2.5">
            <Badge variant="outline" className="h-5 px-2 text-[10px] font-normal text-muted-foreground bg-slate-50 border-border/70 rounded-md shrink-0">
              딜
            </Badge>
            <span className="font-semibold text-[11px] text-foreground truncate">
              {dealName}
            </span>
            {brandName && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant="outline" className="h-5 px-2 text-[10px] font-normal text-muted-foreground bg-slate-50 border-border/70 rounded-md">
                  브랜드
                </Badge>
                <span className="text-[11px] text-muted-foreground truncate">{brandName}</span>
              </div>
            )}
            {partnerName && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant="outline" className="h-5 px-2 text-[10px] font-normal text-muted-foreground bg-slate-50 border-border/70 rounded-md">
                  거래처
                </Badge>
                <span className="text-[11px] text-muted-foreground truncate">{partnerName}</span>
              </div>
            )}
          </div>
          {dealStatus && (
            <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100 text-[11px] font-semibold px-2.5 py-1 rounded-md shrink-0 border-0 shadow-none">
              {dealStatusLabels[dealStatus as DealStatus] ?? dealStatus}
            </Badge>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 p-6 bg-slate-50/30">
          <p className="text-xs text-slate-500">연결된 딜이 없습니다</p>
        </div>
      )}
    </div>
  );
}
