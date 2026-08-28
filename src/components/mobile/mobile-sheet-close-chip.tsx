"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * 풀스크린 시트 공용 닫기 칩 — 화면 우상단에 **항상 떠 있다**.
 *
 * 시트 헤더의 sticky 를 해제(오너 확정 2026-07-16)하면서 닫기만 분리한 것.
 * 완전 해제가 아닌 이유: 이 앱엔 스와이프 닫기 제스처가 없고(vaul 은 설치만 되고
 * 소비처 0) 풀스크린 시트라 오버레이 탭도 없다 — **닫기 버튼이 유일한 탈출구**라
 * 스크롤 밖으로 내보낼 수 없다(ss-ux-designer 판정). 대신 스크롤 중에는 반투명해져
 * 콘텐츠를 가리지 않고, 멈추면 복귀한다. 하단 nav 처럼 완전히 숨기지 않는 것도
 * 의도다 — escape hatch 는 시야에서 사라지면 안 된다.
 *
 * 시각 32px 원 / 터치 44px(size-11)는 오너 확정(2026-07-15) — 바꾸지 말 것.
 * 이전엔 같은 마크업이 시트 3곳에 복사돼 있었다(드리프트 방지 겸 부품화).
 *
 * 스크롤 감지는 document 캡처 리스너 — scroll 은 버블링하지 않지만 캡처는 잡히고,
 * 시트가 풀스크린이라 열려 있는 동안의 모든 스크롤은 시트 내부다(ref 배관 불요).
 */
export function MobileSheetCloseChip({
  label,
  className,
}: {
  /** aria-label — 시트마다 다르게 준다 */
  label: string;
  className?: string;
}) {
  const [dimmed, setDimmed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const onScroll = () => {
      // 같은 값 재설정은 리렌더를 만들지 않는다 — 프레임당 setState 금지(anti-slop 5)와 양립.
      setDimmed(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setDimmed(false);
      }, 180);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [reducedMotion]);

  return (
    <SheetClose asChild>
      {/* 포커스 링은 44px 투명 박스가 아니라 보이는 32px 원에 붙인다 — 박스에 걸면
          원에서 한참 뜬 헤일로가 되어 무엇이 포커스됐는지 흐려진다. */}
      <button
        type="button"
        aria-label={label}
        className={cn(
          "group fixed right-3 top-[calc(env(safe-area-inset-top,0px)+0.375rem)] z-20",
          "flex size-11 shrink-0 items-center justify-center rounded-full",
          className,
        )}
      >
        <span
          className={cn(
            // 흐르는 콘텐츠 위에 뜨므로 배경을 거의 불투명하게 + 얇은 그림자로 분리.
            "flex size-8 items-center justify-center rounded-full bg-slate-100/95 text-slate-500 shadow-soft-sm",
            // 반투명 전환은 CSS transition(인터럽터블) — 스크롤 재개 시 즉시 역방향 재타깃.
            // 곡선은 하단 nav 와 동일한 커스텀 베지어(모션 응집성 — review-animations 기준 10).
            "transition-opacity duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            // 터치 전용 표면이라 hover 대신 active(프레스 틴트) — iOS sticky-hover 방지(P8).
            "active:bg-slate-200 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-focus-ring",
            dimmed && "opacity-55",
          )}
        >
          <XIcon aria-hidden="true" className="size-4" />
        </span>
      </button>
    </SheetClose>
  );
}
