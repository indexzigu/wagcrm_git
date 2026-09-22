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
  /**
   * 기안 목록. kind 까지 키에 넣는다 — 같은 EXECUTED 라도 기안 완료(WRITE)와 봇 조회
   * 결과(READ)는 서로 다른 목록이라 한 캐시를 나눠 쓰면 탭이 서로를 덮어쓴다.
   * 기본값 WRITE 로 무인자·무kind 호출부(사이드바 배지)는 그대로 동작한다.
   * 프리픽스("action-proposals") invalidate 는 이전과 똑같이 전부를 훑는다.
   */
  actionProposals: (status: string, kind: "READ" | "WRITE" = "WRITE") =>
    ["action-proposals", { status, kind }] as const,
  /** 봇 조회 결과 탭(커서 페이지네이션) — 위 프리픽스를 공유해 승인 후 invalidate 에 함께 걸린다. */
  readRecords: () =>
    ["action-proposals", { status: "EXECUTED", kind: "READ" }, "infinite"] as const,
  /** 봇 활동 탭(커서 페이지네이션). 완료 포함 여부가 목록 자체를 바꾸므로 키에 넣는다. */
  agentJobs: (includeSucceeded: boolean) => ["agent-jobs", { includeSucceeded }] as const,
} as const;
