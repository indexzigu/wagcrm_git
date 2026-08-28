import { SellersManagement } from "@/components/crm/sellers-management";
import { getCachedSellersPageData } from "@/lib/cached-crm-data";

export default async function SellersPage() {
  const initialSellers = await getCachedSellersPageData();

  return (
    <SellersManagement
      initialSellers={initialSellers}
    />
  );
}
