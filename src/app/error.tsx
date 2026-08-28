"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Home, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex h-full min-h-[500px] w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_top_right,_rgba(191,80,80,0.06),_transparent_35%),linear-gradient(180deg,_#F8FAFC_0%,_#F1F5F9_100%)] p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="max-w-md w-full rounded-xl border border-white/70 bg-[rgba(255,255,255,0.62)] p-6 shadow-ambient backdrop-blur text-center space-y-6 md:rounded-[24px] md:p-8 dark:bg-slate-900/60 dark:border-slate-800">
        <div className="flex justify-center">
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-full text-rose-600 dark:text-rose-400">
            <AlertTriangle className="size-8" />
          </div>
        </div>
        
        <div className="space-y-2">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-200 md:text-lg">시스템 로드 중 문제가 발생했습니다</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            오류 정보가 보안 규정에 따라 암호화되어 관리자에게 보고되었습니다.<br />
            잠시 후 다시 시도해 주시기 바랍니다.
          </p>
        </div>

        {/* Error Details Accordion */}
        <div className="border border-slate-200/50 rounded-lg bg-white/40 dark:border-slate-800 dark:bg-slate-950/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            <span>오류 정보 식별자 (디버그용)</span>
            {showDetails ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {showDetails && (
            <div className="border-t border-slate-200/50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 p-3 text-left font-mono text-[10px] text-rose-600 dark:text-rose-400 break-all select-all leading-normal">
              <div>Message: {error.message || "Unknown Error"}</div>
              {error.digest && <div className="mt-1">Digest: {error.digest}</div>}
            </div>
          )}
        </div>

        <div className="flex gap-2.5 justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg h-9 px-4 text-xs border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
            onClick={reset}
          >
            <RefreshCw className="size-3.5 mr-1.5" />
            다시 시도
          </Button>
          <Button
            variant="default"
            size="sm"
            className="rounded-lg h-9 px-4 text-xs bg-slate-900 text-white hover:bg-slate-800 shadow-md shadow-slate-900/10 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 dark:shadow-none"
            asChild
          >
            <Link href="/">
              <Home className="size-3.5 mr-1.5" />
              홈으로 이동
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
