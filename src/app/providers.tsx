"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";

/**
 * B1-3 클라이언트 캐싱 — 관제탑 프라이버시 결정(2026-07-05).
 *
 * 이전에는 sellers/partners/deals-list(마스터데이터)를 localStorage에 24h
 * persist했으나, CRM 특성상 거래처·셀러 PII(이름·거래조건)가 평문으로
 * 브라우저에 잔류하는 것은 위험하다고 판단해 persist를 완전히 제거했다.
 *
 * "페이지 이동 → 복귀 시 즉시 표시"라는 핵심 UX는 아래 QueryClient의
 * gcTime(24h)이 유지하는 인메모리 캐시만으로 그대로 보존된다 — 같은 세션
 * 내에서 컴포넌트가 언마운트/재마운트되어도 쿼리 캐시는 QueryClient 인스턴스에
 * 남아있기 때문이다. 포기하는 것은 "브라우저 새로고침 후 즉시 표시"뿐이며,
 * 이는 PII 안전을 위한 의도적 트레이드오프다.
 *
 * 참고: 이전 리뷰가 지적한 "SSR 분기 이중 트리(PersistQueryClientProvider용
 * no-op persister)"와 "initialData vs persist 복원 경합" Minor 이슈는 persist
 * 자체를 제거하면서 함께 해소된다.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5m default (warm) — 훅별로 override
            gcTime: 24 * 60 * 60 * 1000, // 24h — 세션 내 페이지 이동 시 캐시 유지
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  // reducedMotion="user" — 하위 모든 motion 컴포넌트가 OS의 prefers-reduced-motion을
  // 자동 존중한다. animate-ui 계열 컴포넌트는 소스에 자체 reduced-motion 가드가 거의
  // 없으므로(레지스트리 81개 중 1개), 이 래핑이 접근성 전제조건이다.
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </QueryClientProvider>
  );
}
