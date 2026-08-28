"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { CrmSidebar } from "./crm-sidebar";
import { MobileStandaloneGate } from "@/components/mobile/mobile-standalone-gate";
import { isPortalPublicPath } from "@/lib/portal-slug";


export function PersistentSidebarLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();


  // Authentication is resolved by server routes. HttpOnly cookies must not be
  // inferred through document.cookie because that hides the sidebar after login.
  const isNoSidebarPage =
    ["/login", "/auth", "/privacy", "/coupang-partners", "/p/"].some((p) => pathname.startsWith(p)) ||
    // 셀러 전용 주소(/<slug>) 포털 — 내부 사이드바 미노출
    isPortalPublicPath(pathname);

  if (isNoSidebarPage) {
    return <>{children}</>;
  }

  return (
    <MobileStandaloneGate>
      {/* 초기 상태는 **레일(접힘)** 이다 — 펼침은 호버·포커스가 임시로 켠다(peek 모드).
          ⛔ `defaultOpen` 을 되살리지 말 것: 이 사이드바는 저장된 상태를 갖지 않는다.
          종전에는 서버가 쿠키를 읽어 이 값을 내렸는데, 그 읽기 하나가 앱 페이지 20여
          개의 문서 캐시를 통째로 없앴다(티켓 T-052).
          ⚠️ 이 초기 상태와 `SidebarLayoutFallback` 의 자리표시 폭은 여전히 **짝**이다 —
          한쪽만 고치면 정적 셸이 본문으로 교체되는 순간 콘텐츠가 112px 옆으로 뛴다.
          설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md` */}
      <SidebarProvider>
        <CrmSidebar />
        <SidebarInset className="min-w-0 flex-1 animate-fade-in-up bg-background pb-20 md:pb-0">
          {children}
        </SidebarInset>
      </SidebarProvider>
    </MobileStandaloneGate>
  );
}
