"use client";

import { useState, type PointerEvent } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

/**
 * 상태 한 낱말 — **점 + 낱말**.
 *
 * 상태 표시 기준(오너 확정 2026-10-08, 설계 정본: docs/private/specs/2026-10-08-status-wording-proposal.md):
 * ① 상태는 붙여 쓴 한 낱말(복잡하면 두 낱말) — 문장·지시문 금지
 * ② 할 일이 없는 상태에는 이 부품을 쓰지 않는다 — 값이나 「—」를 그린다
 * ③ 색만으로 전하지 않는다 — 점과 낱말이 함께 간다
 * ④ 상태 라벨은 누르는 요소가 아니다 — 조작은 옆의 버튼이 맡는다
 * ⑤ 풀이가 필요한 낱말은 `hint` 로 설명창을 단다(마우스·키보드 포커스·터치)
 *
 * 톤은 P8 §1 의 **심각도 축**만 탄다. 채널·유형 같은 범주에는 쓰지 말 것(§4).
 * 같은 모양의 선례: 회계 일정 계산서 칸(`campaign-invoice-slot.tsx` MonthRow) — 점 크기·점선 밑줄·
 * 터치 열기를 맞췄다.
 */
// ⛔ success(초록) 톤은 두지 않는다 — 정상은 색을 받지 않는다(P8 §2, 위 ②).
export type StatusTone = "urgent" | "caution" | "info" | "neutral";

const DOT_CLASS: Record<StatusTone, string> = {
  urgent: "bg-status-urgent",
  caution: "bg-status-caution",
  info: "bg-status-info",
  neutral: "bg-slate-400",
};

// 흰 카드 위 텍스트 대비(P8 §5): urgent-text 6.4 · caution-text 7.1 · info 5.5 · slate-700 10.3.
const TEXT_CLASS: Record<StatusTone, string> = {
  urgent: "text-status-urgent-text",
  caution: "text-status-caution-text",
  info: "text-status-info",
  neutral: "text-slate-700",
};

export function StatusDot({
  tone,
  label,
  hint,
  className,
  testId,
  showDot = true,
}: {
  tone: StatusTone;
  label: string;
  /** 설명창 문구. 있으면 낱말에 점선 밑줄이 붙고 설명창이 열린다. */
  hint?: string;
  className?: string;
  testId?: string;
  /** 같은 행에 이미 심각도 점이 있으면 끈다(점을 두 번 그리지 않는다 — 데이터 점검 카드). */
  showDot?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const base = cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium",
    TEXT_CLASS[tone],
    className,
  );
  const dot = showDot ? (
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} />
  ) : null;

  if (!hint) {
    return (
      <span className={base} data-testid={testId}>
        {dot}
        <span>{label}</span>
      </span>
    );
  }

  // Radix HoverCard 는 터치의 pointerenter 를 무시한다 — 터치 pointerdown 에서 직접 연다
  // (`taxable-revenue-card.tsx` DetailHover 와 같은 처방). 닫기는 바깥 누름이 맡는다.
  // ⛔ 이 트리거는 버튼이므로 **다른 버튼·링크 안에 넣지 말 것**(중첩 인터랙티브).
  const openOnTouch = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") setOpen(true);
  };
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onPointerDown={openOnTouch}
          data-testid={testId}
          className={cn(
            base,
            "cursor-help rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring",
          )}
        >
          {dot}
          <span className="underline decoration-slate-300 decoration-dotted underline-offset-4">{label}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 p-3 text-xs leading-relaxed text-slate-600">{hint}</HoverCardContent>
    </HoverCard>
  );
}
