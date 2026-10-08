import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSettlementAutoExecutePass } from "@/lib/agent/auto-execute/settlement-auto-execute";

// 정산 금액 수정 자동 실행기(브리지 Phase 2 묶음 B) — 2분마다 한 회차.
// 무엇을 판정·실행하는지는 `settlement-auto-execute.ts` 헤더가 정본이다.
//
// 스위치 `AGENT_AUTO_EXECUTE`(off 기본 | shadow | on), `AUTO_APPROVE_DISABLED` 가 있으면 off.
// off 면 아무것도 하지 않는다(DB 조회도 없다).
//
// 관측: 판정을 새로 남겼거나 실행·정리한 회차만 이력(SystemTaskLog) 1줄을 남긴다. 빈 회차는
// `quiet: true` 로 상태(SystemTaskStatus)만 갱신한다 — 2분 주기라 매 회차 남기면 하루 720줄이다.
// 회차 안의 개별 오류가 하나라도 있으면 `quiet` 이 아니므로 이력에 남는다.

export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSettlementAutoExecutePass();

  // 캐시 무효화는 승인 SSOT 의 후속 처리(write-action-effects)가 실행 건마다 이미 한다.

  // 후보를 하나 이상 시도했는데 전부 예외로 끝났으면 실질 실패다(레이더 빨강).
  const attempted = result.executed + result.executionFailed + result.skipped + result.errors + result.recorded;
  const failed = result.errors > 0 && attempted === result.errors;

  return NextResponse.json({
    ok: !failed,
    ...result,
    ...(failed
      ? { failed: true, failureReason: `자동 실행 회차의 처리 ${result.errors}건이 전부 오류로 끝났습니다` }
      : {}),
  });
}

export const GET = withSystemTaskStatus("agent-auto-execute", handler);
