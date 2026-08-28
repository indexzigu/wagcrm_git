"use client";

import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type CampaignStatus, campaignStatusLabels } from "@/lib/crm-types";
import {
  type ColumnSettings,
  PIPELINE_STAGE_ORDER,
  saveColumnSettings,
  toggleColumnVisibility,
} from "@/lib/column-settings";
import type { ZoneViewMode } from "@/lib/zone-config";

type ColumnVisibilitySettingsProps = {
  settings: ColumnSettings;
  onChange: (settings: ColumnSettings) => void;
  viewMode?: ZoneViewMode;
};

export function ColumnVisibilitySettings({
  settings,
  onChange,
  viewMode,
}: ColumnVisibilitySettingsProps) {
  const visibleCount = PIPELINE_STAGE_ORDER.filter(
    (stage) => settings[stage].visible,
  ).length;

  function handleToggle(stage: CampaignStatus, checked: boolean) {
    // Use the utility function which enforces the minimum-one-visible invariant
    const newSettings = toggleColumnVisibility(settings, stage, checked);
    if (newSettings === null) {
      return; // Rejected: last visible column cannot be hidden
    }
    onChange(newSettings);
    saveColumnSettings(newSettings);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          aria-label="컬럼 표시 설정"
        >
          <Settings2 className="size-3.5" />
          <span>컬럼 설정</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          컬럼 표시/숨김
        </div>
        <div className="space-y-2">
          <TooltipProvider>
            {PIPELINE_STAGE_ORDER.map((stage) => {
              const isVisible = settings[stage].visible;
              const isLastVisible = isVisible && visibleCount <= 1;
              const isViewCProposal =
                viewMode === "VIEW_C" && stage === "PROPOSAL";
              const isDisabled = isLastVisible || isViewCProposal;

              const switchElement = (
                <div
                  key={stage}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Label
                    htmlFor={`col-vis-${stage}`}
                    className="cursor-pointer text-sm font-normal"
                  >
                    {campaignStatusLabels[stage]}
                  </Label>
                  <Switch
                    id={`col-vis-${stage}`}
                    size="sm"
                    checked={isVisible}
                    onCheckedChange={(checked) =>
                      handleToggle(stage, checked as boolean)
                    }
                    disabled={isDisabled}
                    aria-label={`${campaignStatusLabels[stage]} 컬럼 ${isVisible ? "숨기기" : "표시"}`}
                  />
                </div>
              );

              if (isViewCProposal) {
                return (
                  <Tooltip key={stage}>
                    <TooltipTrigger asChild>{switchElement}</TooltipTrigger>
                    <TooltipContent side="left">
                      View C에서는 셀러 제안 컬럼을 변경할 수 없습니다
                    </TooltipContent>
                  </Tooltip>
                );
              }

              if (isLastVisible) {
                return (
                  <Tooltip key={stage}>
                    <TooltipTrigger asChild>{switchElement}</TooltipTrigger>
                    <TooltipContent side="left">
                      최소 1개 컬럼은 표시되어야 합니다
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return switchElement;
            })}
          </TooltipProvider>
        </div>
      </PopoverContent>
    </Popover>
  );
}
