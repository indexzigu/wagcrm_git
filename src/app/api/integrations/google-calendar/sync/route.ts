import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { syncAllCampaignsToCalendar } from "@/lib/google-calendar-sync";

export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const result = await syncAllCampaignsToCalendar();

    if (result.skipped === "not_connected") {
      return NextResponse.json(
        { error: "구글 캘린더가 연결되어 있지 않습니다. 먼저 연동을 완료하세요." },
        { status: 401 },
      );
    }

    return NextResponse.json({
      synced: result.synced,
      total: result.total,
      failed: result.failed,
      message:
        result.total === 0
          ? "동기화할 활성 캠페인이 없습니다."
          : `${result.synced}/${result.total}개 캠페인을 구글 캘린더에 동기화했습니다.${
              result.failed > 0 ? ` (실패 ${result.failed}건)` : ""
            }`,
    });
  } catch (error) {
    console.error("[google-calendar/sync] 동기화 오류:", error);
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
