"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CrmShell } from "./crm-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChannelFee {
  id: string;
  channel: string;
  label: string;
  feeRate: number;
  paymentRate: number;
  notes: string | null;
}

export function ChannelFeesClient({ initialChannels }: { initialChannels: ChannelFee[] }) {
  const [channels, setChannels] = useState(initialChannels);
  const [saving, setSaving] = useState<string | null>(null);

  async function handleSave(channel: ChannelFee) {
    setSaving(channel.channel);
    try {
      const res = await fetch("/api/settings/channel-fees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: channel.channel,
          feeRate: channel.feeRate,
          paymentRate: channel.paymentRate,
          notes: channel.notes,
        }),
      });
      if (res.ok) {
        toast.success(`${channel.label} 수수료율 저장 완료`);
      } else {
        toast.error("저장 실패");
      }
    } catch {
      toast.error("저장 중 오류 발생");
    } finally {
      setSaving(null);
    }
  }

  function updateChannel(channel: string, field: keyof ChannelFee, value: string | number) {
    setChannels((prev) =>
      prev.map((c) => (c.channel === channel ? { ...c, [field]: value } : c))
    );
  }

  return (
    <CrmShell title="채널 수수료 설정">
      <div className="flex-1 overflow-auto px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur p-6 overflow-y-auto">
          <div className="max-w-2xl space-y-6">
            {channels.map((ch) => (
              <div
                key={ch.channel}
                className="rounded-xl border border-slate-200/60 bg-white/80 p-5 space-y-3 shadow-soft-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">{ch.label}</h3>
                    <p className="text-xs text-muted-foreground font-mono">{ch.channel}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-slate-900">{(ch.feeRate + ch.paymentRate).toFixed(2)}%</p>
                    <p className="text-xs text-muted-foreground">합산 수수료</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground font-medium">스토어 수수료 (%)</label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={ch.feeRate}
                      onChange={(e) => updateChannel(ch.channel, "feeRate", parseFloat(e.target.value) || 0)}
                      className="h-8 mt-1 border-slate-200 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground font-medium">결제 수수료 (%)</label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={ch.paymentRate}
                      onChange={(e) => updateChannel(ch.channel, "paymentRate", parseFloat(e.target.value) || 0)}
                      className="h-8 mt-1 border-slate-200 focus-visible:ring-focus-ring"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground font-medium">비고</label>
                  <Input
                    value={ch.notes || ""}
                    onChange={(e) => updateChannel(ch.channel, "notes", e.target.value)}
                    placeholder="메모"
                    className="h-8 mt-1 border-slate-200 focus-visible:ring-focus-ring"
                  />
                </div>

                <Button
                  size="sm"
                  onClick={() => handleSave(ch)}
                  disabled={saving === ch.channel}
                  className="rounded-lg shadow-soft-sm"
                >
                  {saving === ch.channel ? "저장 중..." : "저장"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
