"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FloatingActionButtonProps = {
  onClick: () => void;
  visible: boolean;
};

export function FloatingActionButton({
  onClick,
  visible,
}: FloatingActionButtonProps) {
  if (!visible) return null;

  return (
    <Button
      onClick={onClick}
      aria-label="새 캠페인 추가"
      className={cn(
        "fixed bottom-6 right-6 z-50 min-h-14 min-w-14 rounded-full shadow-soft-lg",
        "hover:shadow-overlay",
      )}
      size="icon-lg"
    >
      <Plus className="size-6" />
    </Button>
  );
}
