import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { refreshInstagramToken } from "@/lib/instagram-token";
import { verifyCronAuth } from "@/lib/cron-auth";

// F5 IG 장기토큰 자동 갱신 크론 (매주 월 02:00 UTC — collect-instagram 03:00 직전)
// 매주 무조건 재교환해 60일 유효기간을 상시 리셋한다. 실패해도 기존 토큰은 유지되고
// SystemSettings.instagramTokenLastError에 사유가 남는다.

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await refreshInstagramToken();
  if (!result.ok) {
    console.error("[refresh-instagram-token] 갱신 실패:", result.error);
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}

export const GET = withSystemTaskStatus("refresh-instagram-token", handler);
