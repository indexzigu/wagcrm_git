"use client";

import { PortalErrorScreen } from "@/components/portal/portal-error-screen";

// 셀러 포털 구간의 오류 경계 — 루트 app/error.tsx(운영자용)가 셀러에게 보이지 않게 가로챈다.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <PortalErrorScreen error={error} retry={unstable_retry} />;
}
