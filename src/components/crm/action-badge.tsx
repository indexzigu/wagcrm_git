"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { calculateFollowUp, type SalesTaskFollowUpInput } from "@/lib/followup-engine";
import { BellRing, CalendarDays } from "lucide-react";

interface ActionBadgeProps {
  task: SalesTaskFollowUpInput;
  referenceDate?: Date;
  onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void;
  className?: string;
}

export function ActionBadge({
  task,
  referenceDate,
  onClick,
  className = "",
}: ActionBadgeProps) {
  const followUp = calculateFollowUp(task, referenceDate);

  if (!followUp) return null;

  const { type, label, badgeColor } = followUp;

  // 아이콘 매핑
  const Icon = type === "MANUAL_REMINDER" ? CalendarDays : BellRing;

  return (
    <Badge
      variant="outline"
      size="compact"
      onClick={(e) => {
        if (onClick) {
          e.stopPropagation();
          onClick(e);
        }
      }}
      className={`transition-[filter,scale] select-none ${
        badgeColor.bg
      } ${badgeColor.text} ${badgeColor.border} ${
        onClick
          ? "cursor-pointer hover:brightness-95 active:scale-95"
          : "cursor-default"
      } ${className}`}
      title={`${label}${task.nextReminderAt ? ` (예정일: ${new Date(task.nextReminderAt).toLocaleDateString()})` : ""}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </Badge>
  );
}
