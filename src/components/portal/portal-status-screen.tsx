import type { ReactNode } from "react";
import {
  PORTAL_NOT_FOUND_ACTION,
  PORTAL_NOT_FOUND_REASON,
  PORTAL_NOT_FOUND_TITLE,
} from "@/lib/portal-not-found";

// 셀러 포털의 막다른 화면(없는·만료된 링크, 불러오기 실패) 공용 틀.
// 외부 셀러가 카톡 링크로 들어와 처음 보는 화면일 수 있으므로 비밀번호 게이트와 같은 모양을 쓰고,
// ⛔ CRM 로그인·홈 링크나 오류 원문·식별자는 넣지 않는다(셀러는 CRM 사용자가 아니다).
export function PortalStatusScreen({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-soft-sm px-6 py-8 text-center">
          <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">WAG Campaign Report</p>
          <h1 className="text-lg font-bold text-slate-900 mt-1.5">{title}</h1>
          <p className="text-xs text-slate-500 mt-3 leading-relaxed">{description}</p>
          {action && <div className="mt-5">{action}</div>}
        </div>
        <p className="mt-4 text-center text-[10px] text-slate-500">
          본 리포트는 와이그라운드가 제공하는 판매 현황 자료입니다.
        </p>
      </div>
    </main>
  );
}

export function PortalNotFound() {
  return (
    <PortalStatusScreen
      title={PORTAL_NOT_FOUND_TITLE}
      description={
        <>
          {PORTAL_NOT_FOUND_REASON}
          <br />
          {PORTAL_NOT_FOUND_ACTION}
        </>
      }
    />
  );
}
