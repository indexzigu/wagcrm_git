"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 분석 경고 배너 — dismiss 불가(경고는 검수 여부와 무관한 사실). 3개 초과 시 접기.
 * 문구는 template-analyze가 만든 한국어 문장을 그대로 렌더(재작성 금지).
 */
export function WarningsBanner({ warnings }: { warnings: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? warnings : warnings.slice(0, 3);
  const hiddenCount = warnings.length - visible.length;

  if (warnings.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border/70 bg-status-caution-bg px-6 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-caution" />
        <div className="flex min-w-0 flex-col gap-0.5">
          {visible.map((warning, i) => (
            <p key={i} className="text-[11px] leading-normal text-foreground/80">
              {warning}
            </p>
          ))}
          {hiddenCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-fit px-1 text-[11px] text-muted-foreground"
              onClick={() => setExpanded(true)}
            >
              경고 {hiddenCount}개 더 보기
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
