import { SettlementPageClient } from "./settlement-page-client";
import { TrackingParamCapture } from "@/components/crm/tracking-param-capture";
import { getCachedDashboardData, getCachedDefaultSettlementMonth } from "@/lib/cached-crm-data";

export default async function SettlementPage() {
  const data = await getCachedDashboardData("settlement");
  const defaultMonth = await getCachedDefaultSettlementMonth();

  return (
    <>
      <TrackingParamCapture />
      <SettlementPageClient initialData={data} defaultMonth={defaultMonth} />
    </>
  );
}
