"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getMarginRatesFromPolicy, type ComputedMargins } from "@/lib/commission";
import type { DealSummary, SalesChannel } from "@/lib/crm-types";

type MarginChangePayload = {
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
  isManualMargin: boolean;
};

type CommissionSmartFormProps = {
  deal: DealSummary | null;
  salesChannel: SalesChannel | null;
  onMarginChange: (margins: MarginChangePayload) => void;
};

export function CommissionSmartForm({
  deal,
  salesChannel,
  onMarginChange,
}: CommissionSmartFormProps) {
  const [manualOverride, setManualOverride] = useState(false);
  const [manualTotal, setManualTotal] = useState<string>("");
  const [manualSeller, setManualSeller] = useState<string>("");

  // Extract policy rates when both deal and salesChannel are selected
  const policyRates: ComputedMargins | null = useMemo(() => {
    if (!deal || !salesChannel) return null;
    return getMarginRatesFromPolicy(deal.baseMarginPolicy, salesChannel);
  }, [deal, salesChannel]);

  // Determine displayed values
  const totalMarginRate = manualOverride
    ? parseFloat(manualTotal) || 0
    : (policyRates?.totalMarginRate ?? 0);

  const sellerMarginRate = manualOverride
    ? parseFloat(manualSeller) || 0
    : (policyRates?.sellerMarginRate ?? 0);

  const netMarginRate = totalMarginRate - sellerMarginRate;

  // Notify parent on every change
  const notifyParent = useCallback(
    (total: number, seller: number, isManual: boolean) => {
      onMarginChange({
        totalMarginRate: total,
        sellerMarginRate: seller,
        netMarginRate: total - seller,
        isManualMargin: isManual,
      });
    },
    [onMarginChange],
  );

  // Notify parent when policy rates change (deal/channel selection)
  useEffect(() => {
    if (!deal || !salesChannel) return;
    if (!manualOverride && policyRates) {
      notifyParent(
        policyRates.totalMarginRate,
        policyRates.sellerMarginRate,
        false,
      );
    }
  }, [deal, salesChannel, policyRates, manualOverride, notifyParent]);

  // Handle manual override toggle
  function handleToggleOverride(checked: boolean) {
    setManualOverride(checked);

    if (checked) {
      // Pre-fill with current policy values
      const total = policyRates?.totalMarginRate ?? 0;
      const seller = policyRates?.sellerMarginRate ?? 0;
      setManualTotal(String(total));
      setManualSeller(String(seller));
      notifyParent(total, seller, true);
    } else {
      // Revert to policy values
      const total = policyRates?.totalMarginRate ?? 0;
      const seller = policyRates?.sellerMarginRate ?? 0;
      setManualTotal("");
      setManualSeller("");
      notifyParent(total, seller, false);
    }
  }

  // Handle manual input changes
  function handleTotalChange(value: string) {
    setManualTotal(value);
    const total = parseFloat(value) || 0;
    notifyParent(total, sellerMarginRate, true);
  }

  function handleSellerChange(value: string) {
    setManualSeller(value);
    const seller = parseFloat(value) || 0;
    notifyParent(totalMarginRate, seller, true);
  }

  // Don't render anything if deal or channel not selected
  if (!deal || !salesChannel) {
    return null;
  }

  // No matching channel policy
  if (!policyRates && !manualOverride) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        해당 채널의 수수료 정책이 없습니다
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Manual Override Toggle */}
      <div className="flex items-center justify-between">
        <Label htmlFor="manual-override" className="text-xs text-muted-foreground">
          수동 입력 (Manual Override)
        </Label>
        <Switch
          id="manual-override"
          size="sm"
          checked={manualOverride}
          onCheckedChange={handleToggleOverride}
        />
      </div>

      {/* No policy notice when override is on but no policy exists */}
      {!policyRates && manualOverride && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          해당 채널의 수수료 정책이 없습니다
        </div>
      )}

      {/* Margin Rate Fields */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">총 마진율 (%)</Label>
          <Input
            type="number"
            step="0.1"
            value={manualOverride ? manualTotal : String(policyRates?.totalMarginRate ?? 0)}
            onChange={(e) => handleTotalChange(e.target.value)}
            disabled={!manualOverride}
            aria-label="총 마진율"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">셀러 마진율 (%)</Label>
          <Input
            type="number"
            step="0.1"
            value={manualOverride ? manualSeller : String(policyRates?.sellerMarginRate ?? 0)}
            onChange={(e) => handleSellerChange(e.target.value)}
            disabled={!manualOverride}
            aria-label="셀러 마진율"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">영업이익율 (%)</Label>
          <Input
            type="number"
            value={String(netMarginRate)}
            disabled
            aria-label="영업이익율"
          />
        </div>
      </div>
    </div>
  );
}
