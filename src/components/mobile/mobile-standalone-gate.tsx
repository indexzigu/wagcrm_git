"use client";

import { ExternalLink, Smartphone } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { useWebAppEnvironment } from "@/hooks/use-web-app-environment";

export function MobileStandaloneGate({ children }: { children: React.ReactNode }) {
  const environment = useWebAppEnvironment();

  if (!environment.isReady || !environment.isMobile || environment.isStandalone) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-dvh items-center bg-[#080B11] px-6 py-10 text-slate-100">
      <section className="mx-auto flex w-full max-w-sm flex-col gap-8">
        <div className="space-y-4">
          {/* 이 화면은 "홈 화면에 추가"를 안내한다 — 배지가 실제 앱 아이콘과 같은 모습이어야
              사용자가 추가 후 찾을 아이콘과 눈으로 이어진다. 그래서 타일(--primary 네이비)까지
              아이콘 파일과 같은 값으로 맞춘다. 네이비 위 골드 5.37:1(3:1 통과).
              라디우스는 #69 형태 사다리의 rounded-2xl 을 따른다 — 아이콘 파일의 rx(22/100)와
              정확히 같지는 않지만, 앱 안 형태 규율이 우선이다. */}
          <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary">
            <BrandMark title="WAG CRM" className="size-10 text-accent-gold" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">WAG CRM 앱으로 실행해 주세요</h1>
            <p className="text-sm leading-6 text-slate-400">
              모바일 CRM 화면은 홈 화면에 추가한 앱에서만 열립니다. 브라우저 상하단 UI 없이
              오늘 할 일과 캠페인 상태를 확인하기 위한 설정입니다.
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300">
          <div className="flex items-start gap-3">
            <ExternalLink className="mt-0.5 size-4 text-slate-400" />
            <p>Safari에서 이 주소를 연 뒤 공유 버튼을 누릅니다.</p>
          </div>
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 size-4 text-slate-400" />
            <p>홈 화면에 추가를 선택하고, 생성된 WAG CRM 아이콘으로 다시 실행합니다.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
