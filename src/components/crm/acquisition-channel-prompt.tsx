"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FIELD_LABELS } from "@/lib/field-labels";
import { acquisitionChannelLabels } from "@/lib/crm-types";
import { ACQUISITION_CHANNELS } from "@/lib/validations/seller";

type AcquisitionChannelPromptProps = {
  sellerId: string;
  /** 값을 저장했거나 「나중에」를 눌러 행을 닫을 때 */
  onDone: () => void;
  /** 저장이 성공했을 때 — 호출부가 셀러 캐시를 갱신한다 */
  onSaved?: (value: string) => void;
  className?: string;
};

const CHIP_CLASS =
  "rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-accent disabled:opacity-50";

/**
 * 유입 경로가 빈 셀러에게 한 줄로 묻는다. 칩을 고르면 바로 저장하고, 「나중에」는 저장 없이 닫는다.
 * 호출부가 needsAcquisitionPrompt 로 먼저 거른다.
 */
export function AcquisitionChannelPrompt({ sellerId, onDone, onSaved, className }: AcquisitionChannelPromptProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/sellers/${sellerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acquisitionChannel: value }),
      });
      if (!res.ok) {
        setError("유입 경로를 저장하지 못했습니다.");
        return;
      }
      onSaved?.(value);
      onDone();
    } catch {
      setError("유입 경로를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="group" aria-label={FIELD_LABELS.acquisitionChannel} className={cn("space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">{FIELD_LABELS.acquisitionChannel}</span>
        {ACQUISITION_CHANNELS.map((value) => (
          <button
            key={value}
            type="button"
            disabled={saving}
            className={CHIP_CLASS}
            onClick={() => void choose(value)}
          >
            {acquisitionChannelLabels[value]}
          </button>
        ))}
        <button type="button" disabled={saving} className={CHIP_CLASS} onClick={onDone}>
          나중에
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
