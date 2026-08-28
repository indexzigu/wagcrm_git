import { revalidateTag } from "next/cache";

export const CRM_CACHE_TAGS = {
  dashboard: "crm:dashboard",
  pipeline: "crm:pipeline",
  settlement: "crm:settlement",
  partners: "crm:partners",
  sellers: "crm:sellers",
  deals: "crm:deals",
  assets: "crm:assets",
  outreach: "crm:outreach",
  reportsPnl: "crm:reports:pnl",
  channelFees: "crm:channel-fees",
  revenueGoals: "crm:revenue-goals",
} as const;

export type CrmCacheTag = (typeof CRM_CACHE_TAGS)[keyof typeof CRM_CACHE_TAGS];

export const CAMPAIGN_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.dashboard,
  CRM_CACHE_TAGS.pipeline,
  CRM_CACHE_TAGS.settlement,
  CRM_CACHE_TAGS.reportsPnl,
] as const satisfies readonly CrmCacheTag[];

// pipeline 태그 제거(2026-07-12 fan-out 축소): /pipeline 이 dynamic 표면으로 전환돼
// 더는 태그 무효화로 재생성되지 않는다(cache-policy.ts CRM_DYNAMIC_SURFACES). pipeline
// 태그를 소비하는 남은 캐시 표면은 홈(getCachedDesktopDashboardData)·셀러 목록인데,
// 이들은 dashboard·sellers 태그를 통해 master-data 쓰기에 이미 재생성되므로 신선도
// 손실이 없다. 셀러 목록의 "최근 캠페인 스냅샷" 재생성은 CAMPAIGN 그룹의 pipeline 태그가
// 계속 담당한다.
export const MASTER_DATA_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.dashboard,
  CRM_CACHE_TAGS.partners,
  CRM_CACHE_TAGS.sellers,
  CRM_CACHE_TAGS.deals,
] as const satisfies readonly CrmCacheTag[];

// pipeline 태그 제거(2026-07-12): /pipeline dynamic 전환으로 불필요. 홈은 dashboard
// 태그로 자산 쓰기에 재생성된다(신선도 손실 없음).
export const ASSET_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.assets,
  CRM_CACHE_TAGS.dashboard,
] as const satisfies readonly CrmCacheTag[];

// pipeline 태그 제거(2026-07-12): /pipeline dynamic 전환으로 불필요. 홈은 dashboard
// 태그로 아웃리치 쓰기에 재생성된다(신선도 손실 없음).
export const OUTREACH_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.outreach,
  CRM_CACHE_TAGS.dashboard,
] as const satisfies readonly CrmCacheTag[];

export const CHANNEL_FEE_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.channelFees,
  CRM_CACHE_TAGS.dashboard,
] as const satisfies readonly CrmCacheTag[];

export const REVENUE_GOAL_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.revenueGoals,
  CRM_CACHE_TAGS.dashboard,
] as const satisfies readonly CrmCacheTag[];

// 크론 이벤트 기반 무효화 (2026-07-10) — TTL을 늘리는 대신 데이터가 실제로 바뀐 순간
// 크론이 직접 캐시를 깬다. 주문 스냅샷 동기화는 포털 리포트(재구매·이력 캐시)와
// 파이프라인/정산 표면에 반영된다.
export const ORDER_SYNC_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.pipeline,
  CRM_CACHE_TAGS.settlement,
] as const satisfies readonly CrmCacheTag[];

// 셀러 지표 수집(팔로워·ER·미디어 재호스팅) — 셀러 목록/상세와 대시보드 모멘텀 카드가 소비.
export const SELLER_METRICS_INVALIDATION_TAGS = [
  CRM_CACHE_TAGS.sellers,
  CRM_CACHE_TAGS.dashboard,
] as const satisfies readonly CrmCacheTag[];

/**
 * Marks shared CRM read caches stale after a successful database mutation.
 */
export function revalidateCrmTags(tags: Iterable<CrmCacheTag>) {
  for (const tag of new Set(tags)) {
    revalidateTag(tag, "max");
  }
}

export function revalidateCampaignCaches() {
  revalidateCrmTags(CAMPAIGN_INVALIDATION_TAGS);
}

export function revalidateMasterDataCaches() {
  revalidateCrmTags(MASTER_DATA_INVALIDATION_TAGS);
}
