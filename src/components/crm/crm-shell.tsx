import * as React from "react";

type CrmShellProps = {
  title?: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  variant?: "default" | "focus";
  children: React.ReactNode;
};

export function CrmShell({ title, description, actions, children }: CrmShellProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#FAF9F6]">
      {(title || actions) && (
        <header className="flex shrink-0 items-center justify-between border-b border-border/40 bg-white/50 px-6 py-4 backdrop-blur-sm md:px-8">
          <div className="flex flex-col gap-0.5">
            {title && (
              <h1 className="text-lg font-bold tracking-tight text-foreground md:text-xl">
                {title}
              </h1>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
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
