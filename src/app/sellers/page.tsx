import { SellersManagement } from "@/components/crm/sellers-management";
import { getCachedSellerEngagementRates, getCachedSellersPageData } from "@/lib/cached-crm-data";

export default async function SellersPage() {
  const [initialSellers, engagementRates] = await Promise.all([
    getCachedSellersPageData(),
    getCachedSellerEngagementRates(),
  ]);

  return (
    <SellersManagement
      initialSellers={initialSellers}
      engagementRates={engagementRates}
    />
  );
}
