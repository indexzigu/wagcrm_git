"use client";

// ---------------------------------------------------------------------------
import { Button } from "@/components/ui/button";
import { Link2 } from "lucide-react";
import { SellerIdentityInfo } from "./seller-identity-info";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SellerLinkSectionProps = {
  sellerId: string | null;
  sellerName: string | null;
  snsType: string | null;
  snsHandle: string | null;
  currentFollowers: number | null;
  fitLevel?: string | null;
  onLinkSeller?: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SellerLinkSection({
  sellerId,
  sellerName,
  snsType,
  snsHandle,
  currentFollowers,
  fitLevel,
  onLinkSeller,
}: SellerLinkSectionProps) {
  // Empty state when no seller is linked
  if (!sellerId) {
    return (
      <div className="space-y-2 rounded-2xl border border-border/70 bg-white/90 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-foreground">연결된 셀러</h3>
          </div>
          {onLinkSeller && (
            <Button
              variant="outline"
              className="h-6 text-[10px] px-2 py-0 gap-0.5 rounded-md border-border/70 text-muted-foreground inline-flex items-center"
              onClick={onLinkSeller}
            >
              <Link2 className="size-2.5" />
              <span>연결</span>
            </Button>
          )}
        </div>
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/70 p-6">
          <p className="text-xs text-muted-foreground">
            연결된 셀러가 없습니다
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-white/90 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-foreground">연결된 셀러</h3>
        </div>
        {onLinkSeller && (
          <Button
            variant="outline"
            className="h-6 text-[10px] px-2 py-0 gap-0.5 rounded-md border-border/70 text-muted-foreground inline-flex items-center"
            onClick={onLinkSeller}
          >
            <Link2 className="size-2.5" />
            <span>연결</span>
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border/50 bg-white hover:bg-slate-50/50 transition-colors p-3">
        <SellerIdentityInfo
          sellerName={sellerName}
          snsType={snsType}
          snsHandle={snsHandle}
          followers={currentFollowers}
          fitLevel={fitLevel}
          variant="compact"
        />
      </div>
    </div>
  );
}
