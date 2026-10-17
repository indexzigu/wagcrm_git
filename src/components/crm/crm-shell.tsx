import * as React from "react";
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

export function CrmShell({ title, description, actions, segments, children }: CrmShellProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {(title || actions || segments) && (
        // 머리는 스크롤러 위 형제로 둔다(스크롤러가 유일한 세로 스크롤러여야 하고
        // flex-1 min-h-0 자식이 높이를 채우는 페이지를 깨지 않기 위함). 반투명 블러는 배경 위에 얹힌다.
        <header className="crm-shell-header flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 px-6 py-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72 md:px-8">
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
            <div className="flex items-center gap-2">
              {actions}
            </div>
          )}
        </header>
      )}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* scrollbar-gutter: 데스크톱 CRM 전 페이지의 실제 세로 스크롤러가 이 div다 —
            스크롤바 등장/소멸로 콘텐츠 폭이 튀는 것을 자리 예약으로 원천 차단(오너 반복 지적 2026-07-23, P8 등재). */}
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
          {children}
        </div>
      </div>
    </div>
  );
}
