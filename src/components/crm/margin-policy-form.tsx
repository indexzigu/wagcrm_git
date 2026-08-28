"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type SalesChannel,
  salesChannelLabels,
  type BaseMarginPolicy,
} from "@/lib/crm-types";

type MarginPolicyFormProps = {
  value: BaseMarginPolicy;
  onChange: (value: BaseMarginPolicy) => void;
  disabled?: boolean;
};

const CHANNELS: SalesChannel[] = ["OWN_MALL", "SELLER_MALL", "BRAND_MALL"];

export function MarginPolicyForm({
  value,
  onChange,
  disabled = false,
}: MarginPolicyFormProps) {
  const valueKey = JSON.stringify(value.byChannel);

  return (
    <MarginPolicyFormInner
      key={valueKey}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

function MarginPolicyFormInner({
  value,
  onChange,
  disabled = false,
}: MarginPolicyFormProps) {
  // Local state for string inputs to avoid cursor jumps with numbers
  const [localRates, setLocalRates] = useState<Record<string, { total: string }>>(() => {
    const initial: Record<string, { total: string }> = {};
    CHANNELS.forEach((channel) => {
      const rate = value.byChannel?.[channel] || { totalMarginRate: 0, sellerMarginRate: 0 };
      initial[channel] = {
        total: rate.totalMarginRate.toString(),
      };
    });
    return initial;
  });

  const handleRateChange = (channel: SalesChannel, val: string) => {
    const nextLocal = {
      ...localRates,
      [channel]: { total: val },
    };
    setLocalRates(nextLocal);

    // Bubble up numeric changes — preserve existing sellerMarginRate
    const nextByChannel = { ...value.byChannel };
    const existingRate = value.byChannel?.[channel];
    nextByChannel[channel] = {
      totalMarginRate: Number(val) || 0,
      sellerMarginRate: existingRate?.sellerMarginRate ?? 0,
    };

    onChange({ ...value, byChannel: nextByChannel });
  };

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-3">
        {CHANNELS.map((channel) => (
          <div
            key={channel}
            className="flex flex-col gap-1 rounded-lg border border-border/70 bg-white/90 p-3 shadow-soft-sm transition-colors focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-focus-ring"
          >
            <Label className="text-[11px] text-muted-foreground font-medium">
              {salesChannelLabels[channel]} 수수료율 (%)
            </Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="any"
              value={localRates[channel]?.total || "0"}
              onChange={(e) => handleRateChange(channel, e.target.value)}
              disabled={disabled}
              className="h-7 w-full border-transparent bg-transparent px-0 text-left text-sm font-semibold tabular-nums text-foreground shadow-none focus-visible:ring-0 outline-none p-0"
              placeholder="0"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

