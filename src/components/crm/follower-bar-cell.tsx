"use client";

import { useEffect, useRef } from "react";
import {
  formatFollowerCount,
  calculateBarWidth,
} from "@/lib/partner-seller-display";

type FollowerBarCellProps = {
  count: number | null | undefined;
};

export function FollowerBarCell({ count }: FollowerBarCellProps) {
  const value = count ?? 0;
  const textRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const textEl = textRef.current;
    const barEl = barRef.current;
    if (!textEl || !barEl) return;

    // 초기 상태 설정
    textEl.textContent = formatFollowerCount(0);
    barEl.style.width = "0%";

    const duration = 1000; // 1초 동안 부드럽게 애니메이션
    const targetBarWidth = calculateBarWidth(value);
    const startValue = 0;
    const startTime = performance.now();
    let rafId: number;

    function animate(now: number) {
      if (!textEl || !barEl) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic

      // 1. 숫자 업데이트 (DOM 직접 수정 - React 리렌더링 유발하지 않음)
      const currentCount = Math.round(startValue + (value - startValue) * eased);
      textEl.textContent = formatFollowerCount(currentCount);

      // 2. 바 너비 업데이트 (DOM 직접 수정 - React 리렌더링 유발하지 않음)
      const currentBarWidth = targetBarWidth * eased;
      barEl.style.width = `${currentBarWidth}%`;

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    }

    // 약간의 딜레이를 주어 마운트 완료 후 애니메이션이 안정적으로 시작되도록 함
    const delayTimer = setTimeout(() => {
      rafId = requestAnimationFrame(animate);
    }, 50);

    return () => {
      clearTimeout(delayTimer);
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [value]);

  return (
    <div className="flex w-[150px] shrink-0 items-center gap-2">
      <span
        ref={textRef}
        className="inline-block w-[68px] shrink-0 text-xs tabular-nums text-right select-none"
      />
      <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-slate-100">
        <div
          ref={barRef}
          className="absolute inset-y-0 left-0 rounded-sm bg-emerald-400"
          style={{ width: "0%" }}
        />
      </div>
    </div>
  );
}

