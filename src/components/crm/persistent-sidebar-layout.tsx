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
        {/* `md:h-svh` — 사이드바 화면 전체의 높이 사슬을 여기서 확정한다. 상위 래퍼는
            `min-h-svh`(최소값)뿐이라, 이게 없으면 `CrmShell` 의 `h-full` 이 기댈 높이가 없어
            넘침이 셸 안쪽 스크롤러가 아니라 창으로 새고, 창 스크롤바 15px 만큼 폭이 흔들린다
            (#84 는 주문관리 한 화면에만 이 앵커를 뒀었다 — T-178 실측: 나머지 CrmShell 화면 전부 재현).
            사이드바 없는 화면(/login·/privacy 등)은 이 요소를 거치지 않아 영향이 없다.
            `flex-1` 과 공존해도 된다 — 부모가 가로 flex 라 `flex-1` 은 폭을, `h-svh` 는 높이를 정한다.
            `md:` 는 모바일 하단 nav 자리(`pb-20`)를 뷰포트 높이가 무시하지 않게 하려는 것.
            ⚠️ 사이드바를 `variant="inset"` 으로 바꾸면 `m-2` 만큼 다시 넘친다. */}
        <SidebarInset className="min-w-0 flex-1 animate-fade-in-up bg-background pb-20 md:h-svh md:pb-0">
          {children}
        </SidebarInset>
      </SidebarProvider>
    </MobileStandaloneGate>
  );
}
