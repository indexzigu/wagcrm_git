"use client";

import { useEffect, useState } from "react";
import { CheckSquare2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXECUTION_CHECKLIST_GROUPS } from "@/lib/campaign-checklist";
import { campaignStatusLabels, type CampaignStatus } from "@/lib/crm-types";
import { formatDate } from "@/lib/format";

export type CampaignTaskChecklistItem = {
  id: string;
  status: string;
  label: string;
  sortOrder: number;
  isRequired: boolean;
  isChecked: boolean;
  completedAt: string | null;
};

type ChecklistSummary = {
  checkedCount: number;
  totalCount: number;
  requiredCheckedCount: number;
  requiredTotalCount: number;
  nextItemLabel: string | null;
  isComplete: boolean;
};

type CampaignTaskChecklistProps = {
  items: CampaignTaskChecklistItem[];
  campaignStatus: CampaignStatus;
  summary: ChecklistSummary | null;
  onToggle: (itemId: string, checked: boolean) => Promise<void>;
  onAddItem: (label: string) => Promise<void>;
};

export function CampaignTaskChecklist({
  items,
  campaignStatus,
  summary,
  onToggle,
  onAddItem,
}: CampaignTaskChecklistProps) {
  const [newItemLabel, setNewItemLabel] = useState("");
  const [isAddingItem, setIsAddingItem] = useState(false);

  const currentItems = [...items]
    .filter((item) => item.status === campaignStatus)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const groupedItems = groupChecklistItems(campaignStatus, currentItems);
  const stageLabel = campaignStatusLabels[campaignStatus];
  const stageDescription = summary?.nextItemLabel
    ? `다음 작업: ${summary.nextItemLabel}`
    : summary?.isComplete
      ? "현재 단계 필수 항목을 모두 완료했습니다."
      : "현재 단계의 필수 작업을 확인하세요.";

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="flex items-center text-sm font-semibold text-foreground">
              <CheckSquare2 className="mr-2 size-4 text-muted-foreground" />
              단계 체크리스트
            </h3>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
              {stageLabel}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {stageDescription}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-medium text-foreground">
            {summary?.checkedCount ?? 0}/{summary?.totalCount ?? 0} 완료
          </div>
          <div className="text-[11px] text-muted-foreground">
            필수 {summary?.requiredCheckedCount ?? 0}/{summary?.requiredTotalCount ?? 0}
          </div>
        </div>
      </div>

      {currentItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-xs text-muted-foreground">
          현재 단계 체크 항목이 없습니다.
        </div>
      ) : (
        <div className="space-y-3">
          {groupedItems.map((group) => (
            <div key={group.title} className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="text-xs font-semibold text-muted-foreground">
                  {group.title}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {group.items.filter((item) => item.isChecked).length}/{group.items.length}
                </div>
              </div>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <ChecklistRow key={item.id} item={item} onToggle={onToggle} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={newItemLabel}
          onChange={(event) => setNewItemLabel(event.target.value)}
          placeholder="현재 단계에 필요한 작업 추가"
          className="flex-1 text-xs"
          onKeyDown={(event) => {
            if (event.key === "Enter" && newItemLabel.trim()) {
              void handleAddItem();
            }
          }}
          aria-label="체크리스트 항목 추가"
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void handleAddItem()}
          disabled={!newItemLabel.trim() || isAddingItem}
        >
          <Plus className="mr-1 size-3.5" />
          추가
        </Button>
      </div>
    </div>
  );

  async function handleAddItem() {
    const label = newItemLabel.trim();
    if (!label) return;

    setIsAddingItem(true);
    setNewItemLabel("");

    try {
      await onAddItem(label);
    } catch {
      setNewItemLabel(label);
      toast.error("체크리스트 항목 추가에 실패했습니다");
    } finally {
      setIsAddingItem(false);
    }
  }
}

function groupChecklistItems(
  campaignStatus: CampaignStatus,
  items: CampaignTaskChecklistItem[],
) {
  const groupConfig =
    campaignStatus in EXECUTION_CHECKLIST_GROUPS
      ? EXECUTION_CHECKLIST_GROUPS[
          campaignStatus as keyof typeof EXECUTION_CHECKLIST_GROUPS
        ]
      : null;

  if (!groupConfig) {
    return [{ title: "현재 단계 작업", items }];
  }

  const remaining = new Map(items.map((item) => [item.id, item]));
  const groups: Array<{ title: string; items: CampaignTaskChecklistItem[] }> = groupConfig
    .map((group) => {
      const labelsArray: string[] = [...group.items];
      const groupItems = items.filter((item) => labelsArray.includes(item.label));
      for (const item of groupItems) {
        remaining.delete(item.id);
      }
      return { title: group.title, items: groupItems };
    })
    .filter((group) => group.items.length > 0);

  const extraItems = [...remaining.values()];
  if (extraItems.length > 0) {
    groups.push({ title: "추가 작업", items: extraItems });
  }

  return groups.length > 0 ? groups : [{ title: "현재 단계 작업", items }];
}

function ChecklistRow({
  item,
  onToggle,
}: {
  item: CampaignTaskChecklistItem;
  onToggle: (itemId: string, checked: boolean) => Promise<void>;
}) {
  const [optimisticChecked, setOptimisticChecked] = useState(item.isChecked);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (!isUpdating) {
      // Intentional sync: local state holds optimistic checkbox mutations.
       
      setOptimisticChecked(item.isChecked);
    }
  }, [item.isChecked, isUpdating]);

  async function handleToggle() {
    const nextChecked = !optimisticChecked;
    setOptimisticChecked(nextChecked);
    setIsUpdating(true);

    try {
      await onToggle(item.id, nextChecked);
    } catch {
      setOptimisticChecked(!nextChecked);
      toast.error("체크리스트 업데이트에 실패했습니다");
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200/80 px-3 py-2.5 transition-colors hover:bg-slate-50/80">
      <input
        type="checkbox"
        checked={optimisticChecked}
        onChange={() => void handleToggle()}
        className="mt-0.5 size-4 rounded border-input accent-primary"
        aria-label={item.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs ${
              optimisticChecked
                ? "text-muted-foreground line-through"
                : "text-foreground"
            }`}
          >
            {item.label}
          </span>
          {item.isRequired ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
              필수
            </span>
          ) : null}
        </div>
        {item.completedAt ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            완료 {formatDate(item.completedAt)}
          </div>
        ) : null}
      </div>
    </label>
  );
}
