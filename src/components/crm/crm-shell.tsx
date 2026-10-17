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

// 머리 높이 측정 전(SSR·첫 페인트) 대용 값 — 제목+설명 머리의 통상 높이.
const FALLBACK_HEADER_HEIGHT = 80;

export function CrmShell({ title, description, actions, segments, children }: CrmShellProps) {
  const hasHeader = Boolean(title || actions || segments);
  const headerRef = React.useRef<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = React.useState(FALLBACK_HEADER_HEIGHT);

  React.useEffect(() => {
    const el = headerRef.current;
    if (!hasHeader || !el) return;
    const measure = () => setHeaderHeight(el.getBoundingClientRect().height || FALLBACK_HEADER_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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
          className={cn(
            "crm-shell-header absolute inset-x-0 top-0 z-10 items-center gap-4 border-b border-border bg-background/80 px-6 py-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72 md:px-8",
            segments ? "grid grid-cols-[1fr_auto_1fr]" : "flex justify-between",
          )}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-foreground">
                {title}
              </h1>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">
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
          className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
          style={pad === undefined ? undefined : { paddingTop: pad, scrollPaddingTop: pad }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
