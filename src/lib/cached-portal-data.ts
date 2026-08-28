import { cacheLife, cacheTag } from "next/cache";
import { CRM_CACHE_TAGS } from "@/lib/cache-tags";
import { CRM_CACHE_LIFE } from "@/lib/cache-policy";
import {
  getSellerCrossCampaignRepurchase,
  type SellerCrossCampaignRepurchase,
} from "@/lib/cross-campaign-repurchase";

// 셀러 포털/상세 공용 캐시 레이어 (2026-07-10, ISR Writes·Fluid CPU 절감).
//
// cached-crm-data.ts에 두지 않는 이유: 이 모듈은 order/포털 도메인 유틸을 끌어와서,
// 모든 캐시 페이지가 import하는 공용 모듈에 합치면 서버 번들이 불필요하게 비대해진다.
//
// 무효화: 캠페인 CRUD(revalidateCampaignCaches → pipeline·settlement)와 셀러
// CRUD/분석(revalidateMasterDataCaches → sellers·pipeline), naver-order-sync 크론
// (ORDER_SYNC_INVALIDATION_TAGS)이 즉시 깨준다. TTL(warm)은 보험이다.
//
// 주의: fetchAndSyncCampaigns(주문 캠페인 페이로드)는 내부에서 after()를 사용해
// "use cache" 안에 넣을 수 없다(런타임 금지). 읽기 전용 분리가 되면 여기로 승격할 것.

const PORTAL_CACHE_TAGS = [
  CRM_CACHE_TAGS.pipeline,
  CRM_CACHE_TAGS.settlement,
  CRM_CACHE_TAGS.sellers,
] as const;

/**
 * 셀러 1명의 크로스캠페인(회차간) 재구매 집계 — 포털 본문·성과 카드·셀러 상세(T3)가 공유.
 */
export async function getCachedSellerRepurchase(
  sellerId: string,
): Promise<SellerCrossCampaignRepurchase> {
  "use cache";
  cacheLife(CRM_CACHE_LIFE.warm);
  cacheTag(...PORTAL_CACHE_TAGS);

  return getSellerCrossCampaignRepurchase(sellerId);
}
