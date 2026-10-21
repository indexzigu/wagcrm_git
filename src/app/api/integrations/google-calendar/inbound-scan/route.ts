import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { runCalendarInboundScan } from "@/lib/calendar-inbound/scan";

/**
 * [캘린더수집] 「캘린더에서 가져오기」(캘린더 화면 도구줄) — 30분 크론을 기다리지 않고 한 회차를 지금 돈다.
 * 크론(`/api/cron/calendar-inbound-scan`)과 같은 `runCalendarInboundScan` 이라 결과·멱등성이 같다 — 같은
 * 일정은 지문 장부가 「이미 처리」로 거르므로 연달아 눌러도 기안이 두 번 생기지 않는다.
 *
 * 인증은 형제 라우트(sync·reconcile)와 같은 `requireAuth` 다. operator 는 미들웨어의 operator 허용
 * 목록(`src/lib/auth-roles.ts`)에 이 경로가 없어 핸들러에 닿기 전에 막힌다.
 *
 * 응답: 성공이면 스캔 요약 그대로(화면이 토스트 문구를 만든다). 연결 없음 401 · 조회 실패 502.
 */
export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const summary = await runCalendarInboundScan();
    if (summary.skipped === "not_connected") {
      return NextResponse.json(
        { ...summary, error: "구글 캘린더가 연결되어 있지 않습니다. 설정 > 외부 연동 진단에서 연동하세요." },
        { status: 401 },
      );
    }
    if (!summary.ok) {
      return NextResponse.json(
        { ...summary, error: `캘린더 일정을 읽지 못했습니다${summary.error ? `: ${summary.error}` : ""}` },
        { status: 502 },
      );
    }
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[google-calendar/inbound-scan] 수집 오류:", error);
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
