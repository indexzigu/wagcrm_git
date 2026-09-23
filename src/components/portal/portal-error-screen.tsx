"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { PortalStatusScreen } from "./portal-status-screen";

// 포털 구간 오류 경계의 화면. 루트 app/error.tsx 는 CRM 운영자용(홈 링크·디버그 식별자)이라
// 셀러에게 그대로 보이면 안 된다 — 여기서는 원인 문구 대신 다시 시도와 연락처만 준다.
export function PortalErrorScreen({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <PortalStatusScreen
      title="리포트를 불러오지 못했어요"
      description={
        <>
          잠시 후 다시 시도해 주세요.
          <br />
          계속 열리지 않으면 담당 매니저에게 알려 주세요.
        </>
      }
      action={
        <button
          type="button"
          onClick={retry}
          className="w-full min-h-11 rounded-xl bg-slate-900 py-3 text-sm font-bold text-white transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          다시 시도
        </button>
      }
    />
  );
}
