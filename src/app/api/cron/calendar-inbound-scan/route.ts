import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runCalendarInboundScan, type ScanSummary } from "@/lib/calendar-inbound/scan";

// [캘린더수집] 구글 캘린더 종일 일정 → 승인 대기 기안 — 30분마다 한 회차(`infra/selfhost/crontab`).
// 한 회차가 무엇을 읽고 무엇을 쓰는지는 `src/lib/calendar-inbound/scan.ts` 헤더가 정본이다.
// 수동 실행(캘린더 화면 「캘린더에서 가져오기」)은 `/api/integrations/google-calendar/inbound-scan` 이
// 같은 `runCalendarInboundScan` 을 부른다.
//
// 관측: 손댄 일정이 없던 회차(처음 보거나 바뀐 일정 0건·오류 0건)는 `quiet: true` 로 상태만 갱신한다 —
// 30분 주기라 매 회차 남기면 하루 48줄이고 정작 기안을 올린 회차가 묻힌다.
// 다른 회차(수동 「캘린더에서 가져오기」 등)가 도는 중이면 스캔이 `skipped: "busy"` 로 아무것도 안 하고 끝난다 —
// 고장이 아니므로 조용한 성공이다(위 quiet 조건에 그대로 걸린다).
// 실패 선언(`failed: true`, 레이더 빨강): 캘린더 연결 없음·후보 조회 실패(`ok: false`), 또는 손댄
// 일정이 전부 오류로 끝난 회차. 일부 오류는 빨강으로 올리지 않는다(상시 노이즈로 빨강이 습관화된다).

export const maxDuration = 300;

/** 오류 말고 어떤 결론이든 낸 건수 — 0 이면서 오류가 있으면 회차가 통째로 헛돈 것이다. */
function settledCount(s: ScanSummary): number {
  return s.proposed + s.adoptedNoop + s.skippedUnparsed + s.awaitingHint + s.dropped + s.alreadyHandled;
}

function failureReasonOf(s: ScanSummary): string | null {
  if (!s.ok) {
    if (s.skipped === "not_connected") return "구글 캘린더 연결이 없어 일정을 읽지 못했습니다";
    return `캘린더 일정을 읽지 못했습니다${s.error ? `: ${s.error}` : ""}`;
  }
  if (s.errors > 0 && settledCount(s) === 0) return `일정 ${s.errors}건 처리가 전부 오류로 끝났습니다`;
  return null;
}

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runCalendarInboundScan();
  const failureReason = failureReasonOf(summary);
  const quiet = summary.ok && summary.errors === 0 && summary.newOrChanged === 0;

  return NextResponse.json({
    ...summary,
    quiet,
    ...(failureReason ? { failed: true, failureReason } : {}),
  });
}

export const GET = withSystemTaskStatus("calendar-inbound-scan", handler);
