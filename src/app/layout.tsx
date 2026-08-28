import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShellFrame } from "@/components/crm/app-shell-frame";
import { PersistentSidebarLayout } from "@/components/crm/persistent-sidebar-layout";
import { SidebarLayoutFallback } from "@/components/crm/sidebar-layout-fallback";
import { PrivacyModeProvider } from "@/components/crm/privacy-mode-provider";
import { Toaster } from "@/components/ui/sonner";
import { DemoModeBanner } from "@/components/crm/demo-mode-banner";
import { MobileBottomNav } from "@/components/mobile/mobile-bottom-nav";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
export const metadata: Metadata = {
  title: "WAG CRM",
  description: "Next-Gen commerce brokerage and sales tracking CRM",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Au79 CRM",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 모바일(iOS Safari)에서 입력창 포커스 시 font-size<16px로 인한 자동 확대(줌)를 막아
  // 화면이 튀지 않고 고정되도록 한다. 설치형 스탠드얼론 CRM이라 앱과 동일한 동작이 자연스럽다.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#080B11",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`h-full ${inter.variable}`}>
      <body className="flex min-h-full flex-col antialiased">
        <Providers>
          <TooltipProvider>
            <PrivacyModeProvider>
              <AppShellFrame>
                {/* fallback 에 {children} 을 넘기지 말 것 — 앱 전역 화이트스크린의 원인이었다.
                    같은 서브트리가 fallback 과 본문 양쪽에 존재하면, React 가 스트리밍된 본문으로
                    fallback 을 교체할 때 insertBefore 가 "이미 DOM 에 있는 자기 조상"을 삽입하려다
                    HierarchyRequestError 로 죽고 화면 전체가 빈다(에러 위치: React 의 $RV reveal).
                    빌드는 통과하고 실기기에서만 터져서 오래 안 잡혔다. */}
                {/* ⛔ 여기에 `cookies()` 를 읽는 서버 경계를 다시 넣지 말 것 —
                    종전 `SidebarStateBoundary` 가 그것이었고, 그 읽기 하나로 앱 페이지
                    20여 개가 「미리 만들어 두는 화면」에서 「요청마다 그리는 화면」으로
                    바뀌었다(티켓 T-052). 사이드바는 이제 저장된 상태를 갖지 않는다.
                    설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md` */}
                <Suspense fallback={<SidebarLayoutFallback />}>
                  <PersistentSidebarLayout>{children}</PersistentSidebarLayout>
                </Suspense>
              </AppShellFrame>
            </PrivacyModeProvider>
            <Toaster />
            <DemoModeBanner />
            <Suspense fallback={null}>
              <MobileBottomNav />
            </Suspense>
          </TooltipProvider>
        </Providers>
        {/* ⛔ Vercel Speed Insights 를 되돌리지 말 것 (제거 2026-08-25). 그 계측은 스크립트를
            `/_vercel/speed-insights/script.js` 에서 받는데, 그 경로를 만드는 것은 앱이 아니라
            **Vercel 엣지**다. 2026-08-13 자체호스팅 컷오버로 엣지가 사라져 요청이 앱까지 내려와
            `src/proxy.ts` 인증 게이트에 `/login`(text/html) 으로 307 되고, 브라우저가 그것을 JS 로
            실행하려다 MIME 오류를 낸다 — 수집 데이터포인트는 0인데 페이지 로드마다(셀러 포털 포함)
            헛요청 1건 + 콘솔 오류 2줄만 남았다. `release` 로 롤백해도 되살리지 않는다: 롤백 창구는
            긴급 구간이라 RUM 실익이 없고, 같은 이유로 `vercel.json` 의 crons 도 이미 비웠다(P6). */}
      </body>
    </html>
  );
}
