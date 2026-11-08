import { SellersManagement } from "@/components/crm/sellers-management";
import { getCachedSellerEngagementRates, getCachedSellersPageData } from "@/lib/cached-crm-data";

export default async function SellersPage() {
  const [initialSellers, engagementRates] = await Promise.all([
    getCachedSellersPageData(),
    // 실패하면 null — 셀러 목록은 그대로 열고, 참여율 조건만 「반영 못한 조건」으로 표시한다.
    getCachedSellerEngagementRates().catch((e: unknown) => {
      console.warn("[sellers] 참여율 조회 실패 — 참여율 조건 미적용:", e instanceof Error ? e.message : e);
      return null;
    }),
  ]);

  return (
    <SellersManagement
      initialSellers={initialSellers}
      engagementRates={engagementRates}
    />
  );
}
