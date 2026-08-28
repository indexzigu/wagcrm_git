"use client";

import { useState } from "react";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  salesChannelLabels,
  type CampaignRow,
  type SellerSummary,
} from "@/lib/crm-types";

export type CampaignDuplicatorProps = {
  sourceCampaign: CampaignRow;
  sellers: SellerSummary[];
  onDuplicated: (newCampaign: CampaignRow) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CampaignDuplicator({
  sourceCampaign,
  sellers,
  onDuplicated,
  open,
  onOpenChange,
}: CampaignDuplicatorProps) {
  const [sellerId, setSellerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exclude the current seller from the dropdown
  const availableSellers = sellers.filter(
    (seller) => seller.id !== sourceCampaign.sellerId,
  );

  async function handleDuplicate() {
    if (!sellerId) return;

    setLoading(true);
    setError(null);

    try {
      await withMutationFeedback(
        (async () => {
          const response = await fetch("/api/campaigns/duplicate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceCampaignId: sourceCampaign.id,
              sellerId,
            }),
          });

          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.error ?? "캠페인 복제에 실패했습니다");
          }

          const newCampaign = (await response.json()) as CampaignRow;
          onDuplicated(newCampaign);
          onOpenChange(false);
          setSellerId("");
        })()
      ).catch((err) => {
        setError(err.message);
      });
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setSellerId("");
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>캠페인 복제</DialogTitle>
          <DialogDescription>
            기존 캠페인의 설정을 복사하여 다른 셀러에게 새 캠페인을 생성합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Source campaign details */}
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">딜</span>
                <span className="font-medium">{sourceCampaign.dealName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">현재 셀러</span>
                <span className="font-medium">
                  {sourceCampaign.sellerName} @{sourceCampaign.snsHandle}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">기간</span>
                <span className="font-medium">
                  {sourceCampaign.startDate} ~ {sourceCampaign.endDate}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">판매 채널</span>
                <span className="font-medium">
                  {salesChannelLabels[sourceCampaign.salesChannel]}
                </span>
              </div>
            </div>
          </div>

          {/* Seller selection */}
          <div className="space-y-2">
            <Label>복제 대상 셀러</Label>
            <Select value={sellerId} onValueChange={setSellerId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="셀러를 선택하세요" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableSellers.map((seller) => (
                    <SelectItem key={seller.id} value={seller.id}>
                      {seller.name} @{seller.snsHandle}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {availableSellers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                선택 가능한 셀러가 없습니다.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            취소
          </Button>
          <Button
            onClick={handleDuplicate}
            disabled={loading || !sellerId}
          >
            {loading ? "복제 중..." : "캠페인 복제"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
