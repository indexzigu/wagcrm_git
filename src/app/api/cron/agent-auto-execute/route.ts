import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSettlementAutoExecutePass } from "@/lib/agent/auto-execute/settlement-auto-execute";
import { recoverStaleApprovedProposals, type StaleApprovedRecoveryResult } from "@/lib/agent/stale-approved-recovery";

// 정산 금액 수정 자동 실행기(브리지 Phase 2 묶음 B) — 2분마다 한 회차.
// 무엇을 판정·실행하는지는 `settlement-auto-execute.ts` 헤더가 정본이다.
//
// 스위치 `AGENT_AUTO_EXECUTE`(off 기본 | shadow | on), `AUTO_APPROVE_DISABLED` 가 있으면 off.
// off 면 정산 자동 실행 회차는 아무것도 하지 않는다(그 회차는 DB 조회도 없다). 아래 멈춘 승인 복구만 돈다.
//
// [T-311] 회차 앞에서 **스위치와 무관하게** 「승인 뒤 실행 전에 멈춘 기안」을 FAILED 로 돌린다
// (`stale-approved-recovery.ts` — 이중 실행이 생기지 않는 근거가 그 헤더에 있다). 상시 2분 주기 크론이 이것뿐이라
// 여기에 얹는다. 복구한 회차·복구 오류가 난 회차는 quiet 이 아니므로 이력에 남는다.
//
// 관측: 판정을 새로 남겼거나 실행·정리한 회차만 이력(SystemTaskLog) 1줄을 남긴다. 빈 회차는
// `quiet: true` 로 상태(SystemTaskStatus)만 갱신한다 — 2분 주기라 매 회차 남기면 하루 720줄이다.
// 회차 안의 개별 오류가 하나라도 있으면 `quiet` 이 아니므로 이력에 남는다.

export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const staleApproved = await recoverStaleApproved();
  const result = await runSettlementAutoExecutePass();

  // 캐시 무효화는 승인 SSOT 의 후속 처리(write-action-effects)가 실행 건마다 이미 한다.

  // 후보를 하나 이상 시도했는데 전부 예외로 끝났으면 실질 실패다(레이더 빨강).
  const attempted = result.executed + result.executionFailed + result.skipped + result.errors + result.recorded;
  const passFailed = result.errors > 0 && attempted === result.errors;
  const recoveryFailed = staleApproved.errors > 0 && staleApproved.recovered === 0;
  const failed = passFailed || recoveryFailed;
  const quiet = result.quiet && staleApproved.recovered === 0 && staleApproved.errors === 0;

  return NextResponse.json({
    ok: !failed,
    ...result,
    quiet,
    staleApproved,
    ...(failed
      ? {
          failed: true,
          failureReason: [
            passFailed ? `자동 실행 회차의 처리 ${result.errors}건이 전부 오류로 끝났습니다` : null,
            recoveryFailed ? `멈춘 승인 복구 ${staleApproved.errors}건이 전부 오류로 끝났습니다` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : {}),
  });
}

/** 복구 자체가 던져도(조회 실패 등) 회차는 돈다 — 오류 1건으로 세어 이력·레이더에 드러낸다. */
async function recoverStaleApproved(): Promise<StaleApprovedRecoveryResult> {
  try {
    return await recoverStaleApprovedProposals();
  } catch (err) {
    console.error("[agent-auto-execute] 멈춘 승인 복구 실패:", err);
    return { recovered: 0, errors: 1 };
  }
}

export const GET = withSystemTaskStatus("agent-auto-execute", handler);
