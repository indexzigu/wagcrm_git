"use client";

import { Badge } from "@/components/ui/badge";
import { SUB_STAGE_BADGE_CONFIG } from "@/lib/badge-config";
import type { CampaignStatus } from "@/lib/crm-types";
import { cn } from "@/lib/utils";

interface SubStageBadgeProps {
  status: CampaignStatus;
  size?: "default" | "compact";
  className?: string;
}

/**
 * Renders a colored badge for a campaign's sub-stage status.
 * Each of the 6 statuses has a unique bg + text color combination
 * that meets WCAG AA 4.5:1 contrast ratio.
 */
export function SubStageBadge({ status, size = "default", className }: SubStageBadgeProps) {
  const config = SUB_STAGE_BADGE_CONFIG[status];

  return (
    <Badge
      variant="outline"
      size={size}
      className={cn(
        // 테두리는 8개 상태가 같은 값이다(한 축 규칙, 오너 결정 2026-07-30) — 그래서
        // config 가 아니라 여기서 한 번 고정한다. `variant="outline"` 이 주는
        // `border-border` 를 이 클래스가 눌러 전 상태를 투명으로 맞춘다.
        // ⚠️ 색이 안 변하는 회귀라 눈에 안 띈다: 이 클래스를 빼면 8개 전부에 헤어라인이
        // 생기고 tsc·기존 테스트는 그대로 통과한다. 계약 테스트가 대신 잡는다.
        size === "default" && "rounded-2xl px-2.5",
        "border-transparent font-medium shadow-none",
        config.bg,
        config.text,
        className,
      )}
    >
      {config.label}
    </Badge>
  );
}
