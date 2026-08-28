import { DealsPageClient } from "./deals-page-client";
import { getCachedDealsPageData } from "@/lib/cached-crm-data";

export default async function DealsPage() {
  const initialDeals = await getCachedDealsPageData();

  return <DealsPageClient initialDeals={initialDeals} />;
}
