"use client";

import { Badge } from "@/components/ui/badge";
import { calculateFollowUp, type SalesTaskFollowUpInput } from "@/lib/followup-engine";
import { BellRing, CalendarDays } from "lucide-react";

interface ActionBadgeProps {
  task: SalesTaskFollowUpInput;
  referenceDate?: Date;
  className?: string;
}

export function ActionBadge({
  task,
  referenceDate,
  className = "",
}: ActionBadgeProps) {
  const followUp = calculateFollowUp(task, referenceDate);

  if (!followUp) return null;

  const { type, label, badgeColor } = followUp;

  // 아이콘 매핑
  const Icon = type === "MANUAL_REMINDER" ? CalendarDays : BellRing;

  // 상태 라벨은 누르는 요소가 아니다(상태 표시 기준 ④, 오너 확정 2026-10-08). 종전엔 `onClick` 을
  // 받으면 눌리는 배지가 됐지만 넘기는 호출처가 없었고, 두 호출처(데스크톱 아웃리치 카드·모바일
  // 아웃리치 행) 모두 행 자체가 눌리는 요소라 배지가 눌리면 중첩 인터랙티브가 된다.
  return (
    <Badge
      variant="outline"
      size="compact"
      className={`select-none cursor-default ${
        badgeColor.bg
      } ${badgeColor.text} ${badgeColor.border} ${className}`}
      title={`${label}${task.nextReminderAt ? ` (예정일: ${new Date(task.nextReminderAt).toLocaleDateString()})` : ""}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </Badge>
  );
}
