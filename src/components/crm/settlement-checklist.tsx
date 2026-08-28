"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, CheckCircle } from "lucide-react";
import type { CampaignRow } from "@/lib/crm-types";

interface SettlementChecklistItem {
  id: string;
  status: string;
  label: string;
  isChecked: boolean;
  completedAt: string | null;
}

interface SettlementChecklistData {
  campaignId: string;
  status: string;
  summary: {
    checkedCount: number;
    totalCount: number;
    requiredCheckedCount: number;
    requiredTotalCount: number;
    nextItemLabel: string | null;
    isComplete: boolean;
  };
  items: SettlementChecklistItem[];
}

interface SettlementChecklistProps {
  campaign: CampaignRow;
  checklist: SettlementChecklistData | null;
  onRefreshCampaign: () => Promise<void>;
  onRefreshChecklist: () => Promise<void>;
}

export function SettlementChecklist({
  campaign,
  checklist,
  onRefreshCampaign,
  onRefreshChecklist,
}: SettlementChecklistProps) {
  const [toggleLoadingId, setToggleLoadingId] = useState<string | null>(null);

  // 체크리스트 개별 항목 토글
  const handleToggleItem = async (itemId: string, currentChecked: boolean) => {
    setToggleLoadingId(itemId);
    try {
      const response = await fetch(`/api/campaign-checklist/items/${itemId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isChecked: !currentChecked,
        }),
      });

      if (!response.ok) {
        throw new Error("체크 상태 업데이트에 실패했습니다.");
      }

      const result = await response.json();
      toast.success("정산 단계 상태가 업데이트되었습니다.");
      
      // 상태 전환이 일어난 경우 토스트 메시지
      if (result.transitioned) {
        toast.info(`캠페인 상태가 "${result.campaignStatus === "COMPLETED" ? "정산 완료" : "정산 진행중"}"으로 변경되었습니다.`);
      }

      await onRefreshChecklist();
      await onRefreshCampaign();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "체크리스트 업데이트 실패");
    } finally {
      setToggleLoadingId(null);
    }
  };

  const items = (checklist?.items || []).filter(
    (item) => item.status === campaign.status,
  );

  return (
    <div className="flex flex-col gap-6 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      {/* 정산 체크리스트 영역 */}
      <div>
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-3">
          <CheckCircle className="size-4 text-primary" />
          정산 단계 체크리스트
        </h4>
        <div className="flex flex-col gap-2">
          {items.length === 0 ? (
            <div className="text-[11px] text-muted-foreground py-2 text-center">
              등록된 정산 단계가 없습니다.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border border-border bg-white p-2.5 shadow-soft-sm hover:border-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`item-${item.id}`}
                    checked={item.isChecked}
                    onChange={() => handleToggleItem(item.id, item.isChecked)}
                    disabled={toggleLoadingId === item.id}
                    className="rounded border-slate-300 text-primary focus:ring-focus-ring size-4 cursor-pointer"
                  />
                  <Label
                    htmlFor={`item-${item.id}`}
                    className={`text-xs cursor-pointer ${
                      item.isChecked ? "text-muted-foreground line-through" : "text-slate-800"
                    }`}
                  >
                    {item.label}
                  </Label>
                </div>
                {toggleLoadingId === item.id && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
              </div>
            ))
          )}
        </div>
        {campaign.status === "COMPLETED" && (
          <p className="mt-2 text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-md p-2">
            💡 모든 정산 체크리스트 완료에 의해 캠페인 상태가 <strong>정산 완료(COMPLETED)</strong>로 자동 전환되었습니다.
          </p>
        )}
      </div>
    </div>
  );
}
