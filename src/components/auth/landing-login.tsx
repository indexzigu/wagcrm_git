import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LandingBrandMark,
  LandingEditorialPanel,
  LandingFooterNote,
  LandingHeadline,
} from "@/components/auth/landing-login-branding";

export async function LandingLogin({
  deniedAccess = false,
  authError = false,
}: {
  deniedAccess?: boolean;
  authError?: boolean;
} = {}) {
  const devBypassEnabled = process.env.NODE_ENV === "development";
  
  const getAppUrl = () => {
    // Vercel Preview 배포 환경인 경우 동적 Preview URL을 우선 사용
    if (process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" && process.env.NEXT_PUBLIC_VERCEL_URL) {
      return `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
    }
    return (
      process.env.NEXT_PUBLIC_SITE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000"
    );
  };
  const appUrl = getAppUrl();

  return (
    <div className="relative min-h-svh w-full bg-[#F8FAFC] font-sans text-slate-900 selection:bg-primary selection:text-white">
      <div className="grid min-h-svh w-full grid-cols-1 lg:grid-cols-[minmax(420px,44%)_1fr]">
        {/* 좌측: 로그인 컬럼.
            상하 여백은 safe-area 를 더한다 — 루트 레이아웃이 viewportFit:"cover" 라 홈 화면에
            추가한 스탠드얼론 웹앱에서는 콘텐츠가 상태바/다이내믹 아일랜드 **밑까지** 깔린다.
            py-8(32px) 만으로는 상단 인셋(다이내믹 아일랜드 ~59px)을 못 덮어 브랜드마크가
            상태바와 겹쳐 보였다(실기기 확인). 하단도 같은 이유로 홈 인디케이터를 피한다.
            일반 브라우저·노치 없는 기기에서는 env() 가 0px 이라 기존 여백 그대로다. */}
        <div className="relative flex flex-col bg-white px-6 pt-[calc(env(safe-area-inset-top,0px)+2rem)] pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] sm:px-10 lg:border-r lg:border-slate-200/70 lg:px-14 lg:pt-[calc(env(safe-area-inset-top,0px)+2.5rem)] lg:pb-[calc(env(safe-area-inset-bottom,0px)+2.5rem)]">
          <header>
            <LandingBrandMark />
          </header>

          {/* 중앙: 로그인 영역 */}
          <main
            aria-labelledby="landing-login-heading"
            className="mx-auto my-auto w-full max-w-sm py-16 animate-fade-in-up"
          >
            {/* 인가 게이트에서 미허가 계정이 돌려보내진 경우 안내 */}
            {deniedAccess && (
              <div
                role="alert"
                className="mb-8 flex items-start gap-3 rounded-xl border border-[#BF5050]/25 bg-[#BF5050]/[0.06] px-4 py-3.5"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[#BF5050]" aria-hidden="true" />
                <div className="space-y-0.5">
                  <p className="text-[13px] font-semibold text-[#8B3A3A]">
                    접근 권한이 없는 계정입니다
                  </p>
                  <p className="text-[13px] leading-relaxed text-slate-600">
                    허가된 계정으로 다시 로그인해 주세요. 접근이 필요하면 관리자에게 문의하세요.
                  </p>
                </div>
              </div>
            )}

            {/* OAuth 코드 교환 실패 등 로그인 자체가 실패해 되돌아온 경우 안내 */}
            {authError && (
              <div
                role="alert"
                className="mb-8 flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3.5"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
                <div className="space-y-0.5">
                  <p className="text-[13px] font-semibold text-amber-800">
                    로그인에 실패했습니다
                  </p>
                  <p className="text-[13px] leading-relaxed text-slate-600">
                    잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 문의하세요.
                  </p>
                </div>
              </div>
            )}

            <LandingHeadline />

            <div className="mt-10 h-px bg-slate-200/80" aria-hidden="true" />

            <div className="mt-10 space-y-5">
              {/* Google OAuth — 유일한 공식 로그인 수단 */}
              <form
                action={async () => {
                  "use server";
                  const supabase = await createClient();
                  const { headers } = await import("next/headers");
                  const headersList = await headers();
                  const host = headersList.get("x-forwarded-host") || headersList.get("host");
                  const protocol = process.env.NODE_ENV === "development" ? "http" : "https";
                  const exactUrl = host ? `${protocol}://${host}` : appUrl;

                  const { data } = await supabase.auth.signInWithOAuth({
                    provider: "google",
                    options: {
                      redirectTo: `${exactUrl}/auth/callback`,
                    },
                  });

                  if (data.url) {
                    redirect(data.url);
                  }
                }}
              >
                <Button
                  type="submit"
                  size="lg"
                  className="group relative h-12 w-full cursor-pointer gap-3 overflow-hidden rounded-xl bg-primary text-[15px] font-semibold text-white shadow-soft-sm shadow-primary/25 transition-colors duration-200 hover:bg-[#0C4A75] focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  {/* 호버 시 한 번 지나가는 광택 스윕 — 장식이므로 reduced-motion에선 숨김 */}
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-10 -skew-x-12 bg-gradient-to-r from-white/0 via-white/15 to-white/0 transition-transform duration-700 ease-out -translate-x-[150%] group-hover:translate-x-[480px] motion-reduce:hidden"
                  />
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white"
                  >
                    {/* size-3.5는 Button 베이스의 svg 크기 강제 규칙([&_svg:not([class*='size-'])]:size-4) 회피용 */}
                    <svg className="size-3.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path
                        fill="#4285F4"
                        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.09A12 12 0 0 0 12 24z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.29A7.21 7.21 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.62H1.27a12 12 0 0 0 0 10.76l4.01-3.09z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A12 12 0 0 0 1.27 6.62l4.01 3.09C6.22 6.88 8.87 4.77 12 4.77z"
                      />
                    </svg>
                  </span>
                  Google로 계속하기
                </Button>
              </form>

              {/* 접근 안내 — 회사 식별 정보가 없는 중립 문구만 서버 컴포넌트에 둔다 */}
              <p className="flex items-center gap-1.5 text-xs leading-relaxed text-slate-500">
                <ShieldCheck className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                허가된 Google 계정으로만 로그인할 수 있습니다.
              </p>

              {/* 개발 환경 전용 바이패스 */}
              {devBypassEnabled && (
                <div className="pt-1">
                  <div className="flex items-center gap-3 py-2" aria-hidden="true">
                    <div className="h-px flex-1 bg-slate-200/80" />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Dev only
                    </span>
                    <div className="h-px flex-1 bg-slate-200/80" />
                  </div>
                  <form action="/api/auth/dev-login" method="POST">
                    <Button
                      type="submit"
                      variant="outline"
                      size="lg"
                      className="h-11 w-full cursor-pointer rounded-xl border-slate-200 text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                    >
                      개발 환경 바이패스 로그인
                    </Button>
                  </form>
                </div>
              )}
            </div>
          </main>

          <footer>
            <LandingFooterNote />
          </footer>
        </div>

        {/* 우측: 에디토리얼 패널 (데스크톱 전용) */}
        <aside
          aria-label="서비스 소개"
          className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24"
        >
          {/* 미세 도트 패턴 */}
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-[0.06] [background-image:radial-gradient(circle,var(--primary)_0.75px,transparent_0.75px)] [background-size:26px_26px]"
          />
          {/* 은은한 네이비 그라디언트 헤이즈 */}
          <div
            aria-hidden="true"
            className="absolute -top-32 right-0 h-[420px] w-[420px] rounded-full bg-primary/[0.06] blur-[110px]"
          />
          <div
            aria-hidden="true"
            className="absolute bottom-0 left-1/4 h-[320px] w-[320px] rounded-full bg-[#0284C7]/[0.05] blur-[100px]"
          />

          {/* 우측 상단 보안 배지 — 중립 문구 */}
          <div className="absolute top-10 right-12 z-10">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 backdrop-blur-sm">
              <span className="size-1.5 rounded-full bg-[#0284C7]" aria-hidden="true" />
              Secure Access
            </span>
          </div>

          <LandingEditorialPanel />
        </aside>
      </div>
    </div>
  );
}
