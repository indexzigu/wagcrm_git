import { IntegrationsDiagnostic } from "@/components/crm/integrations-diagnostic";
import { SystemRadarCard } from "@/components/crm/system-radar-card";
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
    <div className="w-full max-w-5xl space-y-6">
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

      {/* 자동화 작업 상태(구 홈 「시스템 레이더」) — 예약 작업이 예정(KST)대로 돌았는지 · 수동 재실행. 판단 빈도가
          낮은 관제 정보라 홈 맨 아래에서 이곳으로 옮겼다(애플 UI 리뉴얼 묶음 1-b, 오너 2026-10-17).
          경로: 설정 → 외부 연동 진단 → 자동화 작업 상태. id 는 바로가기용. */}
      <section id="automation-status" className="scroll-mt-20">
        <SystemRadarCard />
      </section>
    </div>
  );
}
