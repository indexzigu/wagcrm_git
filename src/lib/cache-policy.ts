import { CRM_CACHE_TAGS, type CrmCacheTag } from "@/lib/cache-tags";

// 2026-07-10 이벤트 기반 전환: 모든 쓰기 경로(CRUD API + 크론 6곳)가 태그 무효화를
// 수행하므로 TTL은 "보험"이다. 짧은 TTL은 Vercel ISR Writes(8KB 단위 과금)만 태우고
// 신선도에 기여하지 않는다 — 수정 반영은 태그가, 주기 데이터 반영은 크론 무효화가 담당한다.
export const CRM_CACHE_LIFE = {
  hot: { stale: 30, revalidate: 300, expire: 3600 },
  warm: { stale: 300, revalidate: 3600, expire: 86400 },
  report: { stale: 900, revalidate: 3600, expire: 86400 },
  // 저변경 설정 표면 전용 — 쓰기 시 태그가 즉시 깨므로 30일 재검증으로 충분
  static: { stale: 300, revalidate: 2_592_000, expire: 31_536_000 },
} as const;

type CacheLifeKey = keyof typeof CRM_CACHE_LIFE;

export type CrmCacheSurface = {
  id: string;
  path: string;
  cacheLife: CacheLifeKey;
  tags: readonly CrmCacheTag[];
  notes: string;
};

export type CrmDynamicSurface = {
  id: string;
  path: string;
  tags: readonly CrmCacheTag[];
  notes: string;
};

export const CRM_CACHE_SURFACES: readonly CrmCacheSurface[] = [
  {
    id: "home",
    path: "/",
    cacheLife: "hot",
    tags: [
      CRM_CACHE_TAGS.dashboard,
      CRM_CACHE_TAGS.pipeline,
      CRM_CACHE_TAGS.settlement,
      CRM_CACHE_TAGS.outreach,
      CRM_CACHE_TAGS.revenueGoals,
    ],
    notes: "Compact cross-workspace desktop summary plus separate lightweight mobile briefing.",
  },
  {
    id: "home-mobile-settlement",
    path: "/ (mobile settlement card)",
    cacheLife: "hot",
    tags: [CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement],
    notes:
      "Mobile home settlement-pending snapshot (card + pending sheet) via getCachedMobileSettlementCampaigns: a narrow two-status select that replaced the getCachedDashboardData('pipeline') kitchen-sink read (#149 review follow-up; /schedule's remaining pipeline read fed only dead fallbacks and was removed outright). dashboard tag intentionally omitted to cut unrelated-write fan-in; deal/seller renames converge within the hot window.",
  },
  {
    id: "settlement",
    path: "/settlement",
    cacheLife: "warm",
    tags: [CRM_CACHE_TAGS.dashboard, CRM_CACHE_TAGS.settlement],
    notes:
      "Settlement operations surface with month-level freshness needs: warm TTL; write-path tags (campaigns API) and the naver-settlement-sync cron invalidate immediately.",
  },
  {
    id: "assets",
    path: "/assets/archive",
    cacheLife: "warm",
    tags: [CRM_CACHE_TAGS.dashboard, CRM_CACHE_TAGS.assets],
    notes:
      "Partial prerendered assets archive using dashboard snapshot. (Path fixed 2026-07-10: the cached consumer is /assets/archive; /assets itself is a client-only hub.)",
  },
  {
    id: "partners",
    path: "/partners",
    cacheLife: "warm",
    tags: [CRM_CACHE_TAGS.partners, CRM_CACHE_TAGS.deals],
    notes:
      "Master-data directory with relational counts. dashboard tag dropped 2026-07-10 (fan-out cut): regenerates on partner/deal writes only, not on unrelated campaign/asset/fee/goal writes.",
  },
  {
    id: "sellers",
    path: "/sellers",
    cacheLife: "warm",
    tags: [CRM_CACHE_TAGS.sellers, CRM_CACHE_TAGS.pipeline],
    notes:
      "Seller directory with recent campaign snapshot. Keeps pipeline (campaign writes refresh the momentum snapshot, real decision value); dashboard tag dropped 2026-07-10.",
  },
  {
    id: "deals",
    path: "/deals",
    cacheLife: "warm",
    tags: [CRM_CACHE_TAGS.deals, CRM_CACHE_TAGS.partners],
    notes:
      "Deals directory with partner linkage and campaign counts. dashboard tag dropped 2026-07-10: the campaign-count badge is low decision value, so it refreshes within the warm window (≤1h) or on the next deal/master-data write rather than on every campaign write (deal detail is live). Re-add pipeline tag if owner wants instant count freshness.",
  },
  {
    id: "reports-pnl",
    path: "/reports/pnl",
    cacheLife: "report",
    tags: [CRM_CACHE_TAGS.reportsPnl],
    notes:
      "Annual report from completed campaigns. dashboard tag dropped 2026-07-10: campaign writes (reportsPnl) refresh it; unrelated master-data changes (e.g. partner rename) converge within the report window.",
  },
  {
    id: "admin-channel-fees",
    path: "/admin/channel-fees",
    cacheLife: "static",
    tags: [CRM_CACHE_TAGS.channelFees],
    notes: "Low-churn admin config page: static tier; channel-fee writes invalidate the tag immediately.",
  },
  {
    id: "admin-meta-review-checklist",
    path: "/admin/integrations/meta/review-checklist",
    cacheLife: "report",
    tags: [CRM_CACHE_TAGS.dashboard],
    notes:
      "Checklist snapshot derived from existing dashboard-backed reads. Rolling 30-day evidence window advances daily: report tier keeps it honest without hot regeneration.",
  },
] as const;

export const CRM_DYNAMIC_SURFACES: readonly CrmDynamicSurface[] = [
  {
    id: "pipeline",
    path: "/pipeline · /pipeline/tasks",
    tags: [CRM_CACHE_TAGS.dashboard, CRM_CACHE_TAGS.pipeline],
    notes:
      "판매 관리 실행 보드. 운영자가 카드 드래그(=campaign status write)로 자기 캐시를 자기가 깨는 고빈도 mutation 표면이라, 서버 ISR 캐시가 read 로 상각되기 전에 재생성만 반복돼 순손실이었다(write:read 역전). getDashboardData 를 use cache 없이 직접 호출하는 PPR(loading.tsx 정적 셸 + 요청당 스트리밍)로 전환: 이 표면의 ISR write 를 제거하고 총 렌더 수도 줄여 Fluid CPU 도 함께 절감. 신선도는 클라 TanStack Query(useCampaigns)가 담당. dashboard/pipeline 태그는 인접 무효화 그룹 추적용(홈·셀러 등 캐시 표면이 pipeline 태그를 소비). 이 표면 자체는 서버 캐시가 아니다.",
  },
  {
    id: "outreach",
    path: "/outreach",
    tags: [CRM_CACHE_TAGS.outreach],
    notes:
      "SalesTask workspace stays client-fetched and highly interactive, so it is intentionally excluded from server cache surfaces.",
  },
  {
    id: "order-converter",
    path: "/order-converter",
    tags: [CRM_CACHE_TAGS.dashboard, CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement],
    notes:
      "Naver order/campaign dashboard is entirely client-fetched via useCampaigns (B1-2 header-based sync metadata + B1-3 TanStack Query). No server cache surface; caching lives client-side only, so it is intentionally excluded from CRM_CACHE_SURFACES.",
  },
  {
    id: "reports-inflow",
    path: "/reports/inflow",
    tags: [],
    notes:
      "유입추적 단축링크 리포트. **캐시를 걸 수 없는 구조적 이유가 있다.** 클릭(LinkClick)은 Cloudflare Worker 가 PostgREST 로 Supabase 에 직접 쓰므로 이 앱에는 그 쓰기를 아는 코드가 없고, 따라서 캐시 태그를 깰 주체가 존재하지 않는다. use cache 를 걸면 무효화가 영원히 일어나지 않아 운영자가 낡은 숫자를 신선한 것으로 읽는다. 태그 목록이 빈 것도 같은 이유다(무효화 그룹에 속하지 않는다). 읽는 테이블이 TrackedLink·LinkClick 둘뿐이라 동적 렌더 비용도 작다.",
  },
  // ── 하이브리드 표면 (2026-07-10) — 페이지 셸은 동적(토큰/파라미터 인증), 무거운 데이터
  // 레이어만 use cache. 캐시 함수는 src/lib/cached-portal-data.ts 참조.
  {
    id: "seller-portal",
    path: "/p/[token] · /[slug]",
    tags: [CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement, CRM_CACHE_TAGS.sellers],
    notes:
      "Seller portal report (both entry points render SellerPortalReport). Cross-campaign repurchase is cached per seller (getCachedSellerRepurchase); past-campaign/settlement history is intentionally disabled on the seller-facing report. The order-campaigns payload stays live because fetchAndSyncCampaigns uses after() (forbidden inside use cache): candidate for a follow-up read-only split.",
  },
  {
    id: "seller-portal-card",
    path: "/p/[token]/card/[campaignId] · /[slug]/card/[campaignId]",
    tags: [CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement, CRM_CACHE_TAGS.sellers],
    notes: "Performance card shares the portal's cached per-seller repurchase aggregate.",
  },
  {
    id: "seller-detail",
    path: "/sellers/[id]",
    tags: [CRM_CACHE_TAGS.pipeline, CRM_CACHE_TAGS.settlement, CRM_CACHE_TAGS.sellers],
    notes:
      "T3 analysis report renders a stored SellerAiProfile snapshot; the heavy cross-campaign repurchase aggregate is cached via getCachedSellerRepurchase. Seller/aiProfile reads stay live (cheap indexed lookups).",
  },
] as const;
