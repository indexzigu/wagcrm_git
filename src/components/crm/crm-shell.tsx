"use client";

import * as React from "react";

type CrmShellProps = {
  variant?: "default" | "focus";
  children: React.ReactNode;
};

/**
 * 데스크톱 CRM 페이지의 바깥 틀 — 세로 스크롤러 하나만 소유한다.
 *
 * ⛔ 페이지 머리(제목·설명 줄)를 두지 않는다 — 오너 디자인 방침(2026-10-21 재확인). 애플 UI 묶음 1(#207)이
 * 모든 화면 위에 84px 머리를 넣어 요약띠·목록이 밀려 내려갔고, 오너 지시로 머리를 없앴다. 분할 버튼·주요 버튼은
 * 각 화면의 카드 도구줄이 소유한다. `title`·`description`·`actions`·`segments` 를 다시 받게 만들지 말 것.
 */
export function CrmShell({ children }: CrmShellProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* scrollbar-gutter: 데스크톱 CRM 전 페이지의 실제 세로 스크롤러가 이 div다 —
            스크롤바 등장/소멸로 콘텐츠 폭이 튀는 것을 자리 예약으로 원천 차단(오너 반복 지적 2026-07-23, P8 등재). */}
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
      </div>
    </div>
  );
}
