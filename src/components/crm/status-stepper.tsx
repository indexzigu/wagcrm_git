"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { patchCampaign } from "@/lib/campaign-patch";
import {
  campaignStatusLabels,
  type CampaignRow,
  type CampaignStatus,
} from "@/lib/crm-types";
import type { ZoneViewMode } from "@/lib/zone-config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered list of all campaign statuses for the stepper. */
export const STATUS_ORDER: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
];

// ---------------------------------------------------------------------------
// Step Classification (pure function — exported for property testing)
// ---------------------------------------------------------------------------

export type StepState = "active" | "completed" | "inactive";

export type StepClassification = {
  status: CampaignStatus;
  label: string;
  state: StepState;
  isInteractive: boolean;
};

/**
 * Classifies each step based on the current status index.
 * - Steps before current: "completed"
 * - Current step: "active"
 * - Steps after current: "inactive"
 * - Only adjacent steps (±1) are interactive (clickable)
 */
export function classifySteps(currentStatus: CampaignStatus): StepClassification[] {
  if (currentStatus === "DROPPED") {
    return [
      {
        status: "DROPPED",
        label: campaignStatusLabels.DROPPED,
        state: "active",
        isInteractive: false,
      },
    ];
  }

  const currentIndex = STATUS_ORDER.indexOf(currentStatus);

  return STATUS_ORDER.map((status, index) => {
    let state: StepState;
    if (index < currentIndex) {
      state = "completed";
    } else if (index === currentIndex) {
      state = "active";
    } else {
      state = "inactive";
    }

    const isInteractive =
      index !== currentIndex &&
      Math.abs(index - currentIndex) === 1;

    return {
      status,
      label: campaignStatusLabels[status],
      state,
      isInteractive,
    };
  });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type StatusStepperProps = {
  currentStatus: CampaignStatus;
  campaignId: string;
  onStatusChanged: (updated: CampaignRow) => void;
  onDrop?: () => void;
  showDropButton?: boolean;
  visibleStatuses?: CampaignStatus[];
  viewMode?: ZoneViewMode;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusStepper({
  currentStatus,
  campaignId,
  onStatusChanged,
  onDrop,
  showDropButton = false,
  visibleStatuses,
}: StatusStepperProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<CampaignStatus | null>(null);

  const steps = classifySteps(currentStatus).filter(
    (step) => !visibleStatuses || visibleStatuses.includes(step.status),
  );
  const currentIndex = STATUS_ORDER.indexOf(currentStatus);

  async function handleStatusChange(targetStatus: CampaignStatus) {
    setIsLoading(true);
    try {
      const result = await patchCampaign<CampaignRow>(
        campaignId,
        { status: targetStatus },
        { fallbackError: "상태 변경에 실패했습니다.", networkError: "상태 변경에 실패했습니다." },
      );

      if (!result.ok) {
        // 기존 단문("상태 변경에 실패했습니다.")은 3초로 충분하지만, 그룹 충돌 안내는
        // 원인 + 재시도 2절이라 같은 문형의 보드 토스트와 같은 5초를 준다.
        toast.error(result.error, { duration: result.conflict ? 5000 : 3000 });
        return;
      }

      onStatusChanged(result.data);
    } finally {
      setIsLoading(false);
    }
  }

  function handleStepClick(targetStatus: CampaignStatus) {
    const targetIndex = STATUS_ORDER.indexOf(targetStatus);

    // Backward navigation: show confirmation dialog
    if (targetIndex < currentIndex) {
      setConfirmTarget(targetStatus);
      return;
    }

    // Forward navigation: immediate API call
    handleStatusChange(targetStatus);
  }

  function handleConfirm() {
    if (confirmTarget) {
      handleStatusChange(confirmTarget);
      setConfirmTarget(null);
    }
  }

  function handleCancel() {
    setConfirmTarget(null);
  }

  return (
    <>
      <div className="flex items-center gap-1 w-full overflow-x-auto py-1">
        {steps.map((step, index) => (
          <button
            key={step.status}
            type="button"
            disabled={!step.isInteractive || isLoading}
            onClick={() => handleStepClick(step.status)}
            className={cn(
              "relative flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors min-w-0 flex-1",
              // Active step
              step.state === "active" &&
                "bg-primary text-primary-foreground",
              // Completed step
              step.state === "completed" &&
                step.isInteractive &&
                "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer",
              step.state === "completed" &&
                !step.isInteractive &&
                "bg-primary/10 text-primary/60",
              // Inactive step
              step.state === "inactive" &&
                step.isInteractive &&
                "bg-muted text-muted-foreground hover:bg-muted/80 cursor-pointer",
              step.state === "inactive" &&
                !step.isInteractive &&
                "bg-muted/50 text-muted-foreground/50",
              // Disabled state
              (!step.isInteractive || isLoading) &&
                step.state !== "active" &&
                "cursor-not-allowed",
            )}
            aria-current={step.state === "active" ? "step" : undefined}
            aria-label={`${step.label} (${index + 1}/${steps.length})`}
          >
            <span className="flex items-center gap-0.5">
              {step.state === "completed" && (
                <Check className="size-3 shrink-0" />
              )}
              <span className="truncate">{step.label}</span>
            </span>
          </button>
        ))}

        {/* 드랍 처리 — 8번째 단계로 스테퍼 끝에 배치 */}
        {showDropButton && onDrop ? (
          currentStatus === "DROPPED" ? (
            <div
              className="relative flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium min-w-0 flex-1 bg-status-urgent text-white"
            >
              <span className="truncate">드랍</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onDrop}
              className="relative flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors min-w-0 flex-1 bg-status-urgent-bg text-status-urgent-text border border-status-urgent/20 hover:border-status-urgent/40 cursor-pointer"
              aria-label="드랍 처리 (8/8)"
            >
              <span className="truncate">드랍</span>
            </button>
          )
        ) : null}
      </div>

      {/* Backward navigation confirmation dialog */}
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) handleCancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>상태 변경 확인</AlertDialogTitle>
            <AlertDialogDescription>
              캠페인 상태를 &ldquo;
              {confirmTarget ? campaignStatusLabels[confirmTarget] : ""}
              &rdquo;(으)로 되돌리시겠습니까?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>확인</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
