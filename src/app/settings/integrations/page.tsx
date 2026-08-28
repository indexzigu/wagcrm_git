import { IntegrationsDiagnostic } from "@/components/crm/integrations-diagnostic";
import {
  getGoogleDriveConnectionStatus,
  SUPABASE_FREE_STORAGE_LIMIT_BYTES,
} from "@/lib/asset-storage";
import { getGoogleCalendarConnectionStatus } from "@/lib/google-calendar";
import { estimateSupabaseAssetBytes } from "@/lib/assets";

export default async function IntegrationsDiagnosticPage() {
  const [driveStatus, calendarStatus, supabaseEstimatedBytes] = await Promise.all([
    getGoogleDriveConnectionStatus(),
    getGoogleCalendarConnectionStatus(),
    estimateSupabaseAssetBytes(),
  ]);

  const supabaseStats = {
    supabaseEstimatedBytes,
    supabaseLimitBytes: SUPABASE_FREE_STORAGE_LIMIT_BYTES,
  };

  return (
    <IntegrationsDiagnostic
      initialDriveStatus={{
        ...driveStatus,
        status: driveStatus.status as "CONNECTED" | "DISCONNECTED" | "ERROR",
      }}
      initialCalendarStatus={{
        ...calendarStatus,
        status: calendarStatus.status as "CONNECTED" | "DISCONNECTED" | "ERROR",
      }}
      supabaseStats={supabaseStats}
    />
  );
}
