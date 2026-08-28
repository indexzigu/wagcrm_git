// 셀러 전용 주소 포털 — crm.ygrd.kr/<셀러계정명>. 슬러그는 공개 취급(계정명 기반)이고
// 접근 비밀은 비밀번호뿐이다: 게이트 통과 시 30일 세션 쿠키(HMAC 서명, portal-auth.ts).
// CRM 관리자 세션은 게이트를 우회한다(소유자가 "열기"로 셀러 화면을 그대로 확인).
// proxy(미들웨어)는 isPortalPublicPath로 이 경로만 공개로 열고, 인증은 이 페이지가 수행한다.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { SellerPortalReport } from "@/components/portal/seller-portal-report";
import { resolvePortalSeller, isPortalAuthorized } from "@/lib/portal-gate";
import { loginToPortal } from "./actions";

export const metadata: Metadata = {
  title: "캠페인 리포트",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ e?: string }>;
};

function PasswordGate({
  slug,
  displayName,
  hasPassword,
  error,
}: {
  slug: string;
  displayName: string;
  hasPassword: boolean;
  error?: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-soft-sm px-6 py-8">
          <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase text-center">
            WAG Campaign Report
          </p>
          <h1 className="text-lg font-bold text-slate-900 mt-1.5 text-center">
            {displayName}님의 캠페인 리포트
          </h1>

          {/* 보안 안심 신호(§5) — 셀러가 카톡 링크로 들어와 "피싱 아닌가" 하는 첫 순간의 우려를
              덜어준다. 자물쇠/방패 하나로 '암호화(안전)'와 '와이그라운드 공식(정품)'을 함께 전달. */}
          <div className="mt-2.5 flex items-center justify-center gap-1.5">
            <ShieldCheck className="size-3.5 text-blue-500 shrink-0" aria-hidden="true" />
            <span className="text-[10px] font-medium text-slate-500">
              암호화로 안전하게 보호되는 와이그라운드 공식 리포트예요
            </span>
          </div>

          {hasPassword ? (
            <>
              <p className="text-xs text-slate-500 mt-3 text-center leading-relaxed">
                리포트 열람용 비밀번호를 입력해주세요.
                <br />
                비밀번호는 담당 매니저에게 안내받으실 수 있어요.
              </p>
              <form action={loginToPortal.bind(null, slug)} className="mt-5 space-y-3">
                <input
                  type="password"
                  name="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  placeholder="비밀번호"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
                {error === "wrong" && (
                  <p className="text-[11px] font-medium text-red-500">비밀번호가 올바르지 않습니다.</p>
                )}
                {error === "locked" && (
                  <p className="text-[11px] font-medium text-red-500">
                    시도 횟수를 초과했습니다. 15분 후 다시 시도해주세요.
                  </p>
                )}
                <button
                  type="submit"
                  className="w-full rounded-xl bg-slate-900 py-3 text-sm font-bold text-white transition-colors hover:bg-slate-700"
                >
                  리포트 열기
                </button>
              </form>
            </>
          ) : (
            <p className="text-xs text-slate-500 mt-3 text-center leading-relaxed">
              아직 열람 비밀번호가 설정되지 않았습니다.
              <br />
              담당 매니저에게 문의해주세요.
            </p>
          )}
        </div>
        <p className="mt-4 text-center text-[10px] text-slate-300">
          본 리포트는 와이그라운드가 제공하는 판매 현황 자료입니다.
        </p>
      </div>
    </div>
  );
}

export default async function SellerSlugPortalPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const seller = await resolvePortalSeller(slug);
  if (!seller) notFound();

  if (await isPortalAuthorized(seller)) {
    return <SellerPortalReport seller={seller} basePath={`/${slug}`} />;
  }

  const { e } = await searchParams;
  return (
    <PasswordGate
      slug={slug}
      displayName={seller.alias || seller.name}
      hasPassword={!!seller.portalPasswordHash}
      error={e}
    />
  );
}
