"use client";

import { useState, type PointerEvent } from "react";
import { CircleCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

const HINT = "현재 값이 이 기안이 바꾸려던 값과 이미 같습니다. 다시 실행하지 않고 종결해도 됩니다.";

/**
 * 실패 기안의 「이미반영됨」 배지 — 서버 판정(`lib/agent/already-applied.ts`)이 true 일 때만 그린다.
 * 목록 카드(`approval-cards.tsx` FailedCard)와 상세 카드(`proposal-card.tsx`)가 함께 쓴다.
 *
 * 풀이는 설명창으로 연다 — 마우스·키보드 포커스·터치(P2 화면 문구 기준 ②, 패턴 정본 `status-dot.tsx` 의 `hint`).
 * ⛔ `title` 속성으로 되돌리지 말 것: 터치·키보드에서 열리지 않는다(ss-ux 검토 2026-11-28).
 * 초록(`status-success`)은 이 카드의 할 일이 재시도가 아니라 정리라는 신호다 — 완료 계열 배지 관례의 연장.
 */
export function AlreadyAppliedBadge() {
  const [open, setOpen] = useState(false);
  // Radix HoverCard 는 터치의 pointerenter 를 무시한다 — 터치 pointerdown 에서 직접 연다(`status-dot.tsx` 와 같은 처방).
  const openOnTouch = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") setOpen(true);
  };
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onPointerDown={openOnTouch}
          className="cursor-help rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          <Badge variant="status-success">
            <CircleCheckIcon aria-hidden />
            <span className="underline decoration-dotted underline-offset-4">이미반영됨</span>
          </Badge>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 p-3 text-xs leading-relaxed text-slate-600">{HINT}</HoverCardContent>
    </HoverCard>
  );
}
