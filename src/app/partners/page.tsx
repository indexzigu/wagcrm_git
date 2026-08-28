import { PartnersManagement } from "@/components/crm/partners-management";
import { getCachedPartnersPageData } from "@/lib/cached-crm-data";

export default async function PartnersPage() {
  const initialPartners = await getCachedPartnersPageData();

  return (
    <PartnersManagement
      initialPartners={initialPartners}
    />
  );
}
