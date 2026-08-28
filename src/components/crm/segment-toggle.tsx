"use client";

// 공용 세그먼트 토글 — 상호배타 단일 선택(필터) 컨트롤. WCAG radiogroup 패턴을 내장한다.
// 접근성 검토(2026-07-07) 반영: 기존 셀러 페이지 인라인 토글은 그냥 <button> 3개라
// 스크린리더가 "필터 그룹/선택 상태"를 못 읽고(4.1.2·1.3.1), 색으로만 선택을 구분하고(1.4.1),
// 포커스링이 브라우저 기본이라 앱 표준과 달랐다(2.4.11). 이 컴포넌트로 승격해 셀러에서 쓰면
// 향후 딜·거래처로 확산될 때 결함이 복제되지 않는다.
//
// - role="radiogroup" + 각 옵션 role="radio" aria-checked (이름·역할·상태 노출)
// - roving tabindex + 방향키(← → ↑ ↓, Home/End) 순환 (2.4.3·2.1.1)
// - 선택 단서를 색 + font-weight 이중으로 (1.4.1)
// - 표준 focus-visible ring-2 ring-focus-ring (2.4.11·2.4.7) — 정본 색 토큰 --focus-ring(globals.css, 3:1 준수)
// - 비선택 텍스트 slate-600으로 대비 확보(11px에서 slate-500은 4.6:1 아슬 → 7:1)
// - 툴바 컨트롤 높이 h-9 정렬

import * as React from "react";
import { cn } from "@/lib/utils";

export type SegmentOption<T extends string> = { value: T; label: string };

export function SegmentToggle<T extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const btnRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const selectAt = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onValueChange(opt.value);
    btnRefs.current[index]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + options.length) % options.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = options.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    selectAt(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-9 shrink-0 items-center rounded-lg border border-slate-200 bg-white p-1",
        className
      )}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              "h-7 rounded-md px-2.5 text-[11px] font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              selected
                ? "bg-slate-800 text-white"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
