/**
 * B1-3 클라이언트 캐싱 — TanStack Query 키 팩토리.
 *
 * 서버측 cache-policy.ts(hot/warm/report)의 투영을 클라이언트 staleTime으로 옮긴다:
 * - deals/sellers/partners(마스터데이터) = warm(5m)
 * - campaigns(주문/캠페인 대시보드) = hot 근접(60s) — 헤더 기반 동기화 메타가 있어 별도 관리
 *
 * 프라이버시 결정(2026-07-05): 이전에는 sellers/partners/deals-list를
 * localStorage에 persist하는 화이트리스트(WHITELIST_KEYS)가 있었으나, CRM
 * 특성상 거래처·셀러 PII(이름·거래조건)가 평문으로 브라우저에 24h 잔류하는
 * 위험을 없애기 위해 persist 기능 자체를 제거했다(src/app/providers.tsx는
 * 이제 순수 QueryClientProvider). "페이지 이동 → 복귀 즉시표시"는 gcTime(24h)
 * 기반 인메모리 캐시로 유지되고, "새로고침 후 즉시표시"만 포기한다.
 */
export const queryKeys = {
  sellers: () => ["sellers"] as const,
  partners: () => ["partners"] as const,
  deals: {
    list: () => ["deals", "list"] as const,
    detail: (id: string) => ["deals", "detail", id] as const,
    profitability: () => ["deals", "profitability"] as const,
  },
  campaigns: () => ["campaigns"] as const,
  mobilePulse: () => ["mobile-pulse"] as const,
  outreach: () => ["outreach"] as const,
  actionProposals: (status: string) => ["action-proposals", { status }] as const,
} as const;
