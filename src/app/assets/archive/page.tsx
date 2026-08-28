import { AssetLibrary } from "@/components/crm/asset-library";
import { getCachedDashboardData } from "@/lib/cached-crm-data";

export default async function AssetsArchivePage({
  searchParams,
}: {
  searchParams?: Promise<{ drive?: string }>;
}) {
  const data = await getCachedDashboardData();
  const params = await searchParams;
  const driveStatus = params?.drive === "connected" || params?.drive === "error"
    ? params.drive
    : null;

  return <AssetLibrary initialData={data} driveStatus={driveStatus} />;
}
