import { PnlReportClient } from "@/components/crm/pnl-report-client";
import { getCachedCurrentYearPnlReportData } from "@/lib/cached-crm-data";

export default async function PnlReportPage() {
  const report = await getCachedCurrentYearPnlReportData();

  return <PnlReportClient report={report} />;
}
