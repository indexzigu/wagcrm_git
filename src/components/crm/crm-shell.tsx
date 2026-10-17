"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { SegmentToggle, type SegmentOption } from "./segment-toggle";

type CrmShellProps = {
  title?: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  variant?: "default" | "focus";
  /** 머리 가운데에 놓는 분할 버튼(보기 전환). 없으면 렌더하지 않는다. */
  segments?: {
    options: ReadonlyArray<SegmentOption<string>>;
    value: string;
    onValueChange: (value: string) => void;
    ariaLabel?: string;
  };
  children: React.ReactNode;
};

/**
 * 머리의 최소 높이(px) — **모든 메뉴의 내용 시작선이 같도록** 설명 한 줄 자리까지 늘 예약한다
 * (P8 Layout Stability: 메뉴를 옮길 때 첫 내용이 위아래로 튀지 않게). 위아래 padding 16+16 ·
 * 제목 28px×1.15 · 간격 2 · 설명 한 줄 16 · 아래 선 1 = 83.2 → 84. 측정 전(SSR·첫 페인트)
 * 스크롤러 padding-top 대용 값도 이 값이라, 측정 결과가 같으면 아무 것도 움직이지 않는다.
 */
export const HEADER_MIN_HEIGHT = 84;

// useLayoutEffect 는 서버에서 경고만 낸다 — 클라이언트에서만 레이아웃 이펙트로 재서
// 보정한 padding 이 첫 페인트 전에 들어가게 한다(src/components/ui/sidebar.tsx 와 같은 방식).
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export function CrmShell({ title, description, actions, segments, children }: CrmShellProps) {
  const hasHeader = Boolean(title || actions || segments);
  const headerRef = React.useRef<HTMLElement | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = React.useState(HEADER_MIN_HEIGHT);
  // 내용이 머리 밑으로 지나갈 때만 아래 선을 그린다(스크롤 가장자리 표시).
  const [scrolled, setScrolled] = React.useState(false);

  useIsomorphicLayoutEffect(() => {
    const el = headerRef.current;
    if (!hasHeader || !el) return;
    const measure = () => setHeaderHeight(el.getBoundingClientRect().height || HEADER_MIN_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasHeader]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!hasHeader || !el) return;
    const onScroll = () => setScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasHeader]);

  const pad = hasHeader ? headerHeight : undefined;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {hasHeader && (
        // 머리는 스크롤러 위에 겹쳐 놓는다(내용이 반투명 머리 밑으로 지나가게). 스크롤러에는
        // 머리 높이만큼 padding-top 을 줘 첫 내용이 가려지지 않고, h-full 자식은 padding 을
        // 뺀 content box 기준이라 넘치지 않는다.
        <header
          ref={headerRef}
          data-scrolled={scrolled ? "" : undefined}
          style={{ minHeight: HEADER_MIN_HEIGHT }}
          className={cn(
            // 바탕 90%(블러 미지원)·85%(블러 지원) — 그 아래로 지나가는 표·칩 글자가 제목·설명과 겹쳐
            // 읽히지 않는 하한. 아래 선은 평소 투명, 내용이 머리 밑으로 스크롤됐을 때만 보인다.
            "crm-shell-header absolute inset-x-0 top-0 z-10 items-center gap-4 border-b border-transparent bg-background/90 px-6 py-4 backdrop-blur-xl transition-[border-color] duration-150 data-[scrolled]:border-border supports-[backdrop-filter]:bg-background/85 md:px-8",
            segments ? "grid grid-cols-[1fr_auto_1fr]" : "flex justify-between",
          )}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <h1 className="text-[length:var(--font-size-heading)] font-bold leading-[1.15] tracking-[-0.02em] text-foreground">
                {title}
              </h1>
            )}
            {description && (
              // 데스크톱은 한 줄 — 넘치면 말줄임, 전체 문장은 title 로 남긴다.
              <p className="truncate text-xs text-slate-600" title={description}>
                {description}
              </p>
            )}
          </div>
          {segments && (
            <SegmentToggle
              options={segments.options}
              value={segments.value}
              onValueChange={segments.onValueChange}
              ariaLabel={segments.ariaLabel ?? "보기 전환"}
            />
          )}
          {actions && (
            <div className={cn("flex items-center gap-2", segments && "col-start-3 justify-self-end")}>
              {actions}
            </div>
          )}
        </header>
      )}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* scrollbar-gutter: 데스크톱 CRM 전 페이지의 실제 세로 스크롤러가 이 div다 —
            스크롤바 등장/소멸로 콘텐츠 폭이 튀는 것을 자리 예약으로 원천 차단(오너 반복 지적 2026-07-23, P8 등재). */}
        <div
          ref={scrollerRef}
          className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
          style={pad === undefined ? undefined : { paddingTop: pad, scrollPaddingTop: pad }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
