/**
 * 마지막 반영 시도의 요약 — 검수 화면 「반영 결과」 카드가 읽는 형태로 접는다.
 *
 * 반영은 `ActionProposal`(requestType "price_sheet_apply")로 기록되고, 실패해도
 * 시트 상태는 재시도 가능하도록 이전 값으로 되돌아간다(오너 결정). 그래서 **실패 사실이
 * 시트에는 남지 않고 제안 레코드에만 남는다** — 그 기록을 화면으로 끌어올리는 것이 이
 * 모듈의 역할이다. 종전에는 토스트만 있어서 새로고침하면 성공·실패 어느 쪽도 확인할
 * 방법이 없었다.
 *
 * 순수 모듈이다(클라이언트 컴포넌트가 타입을 import한다) — prisma 등 서버 전용 import 금지.
 */

/** 화면이 구분하는 3상태. 제안의 세부 전이 상태를 여기서 접는다. */
export type ApplyOutcome = "RUNNING" | "SUCCEEDED" | "FAILED";

export type ApplySummary = {
  proposalId: string;
  outcome: ApplyOutcome;
  /** 생성된 딜 수(상위딜·하위품목딜 포함). */
  createdCount: number;
  /** 갱신된 기존 딜 수. */
  updatedCount: number;
  /** 실행 완료 시각(ISO). 진행중이면 null. */
  finishedAt: string | null;
  /** 실패 사유. 실패가 아니면 null. */
  errorMessage: string | null;
};

/** 반영 실행기가 executionResult에 남기는 형태(apply-executor의 runApplyActions 반환값). */
type ExecutionResult = {
  results?: Array<{ dealId?: string; action?: "CREATE" | "UPDATE" }>;
};

/**
 * ActionProposal 한 건을 화면용 요약으로 접는다.
 *
 * 상태 매핑 — 제안은 DRAFT → PENDING_APPROVAL → APPROVED → EXECUTED 를 한 요청 안에서
 * 순차 전이하므로, EXECUTED/FAILED 가 아닌 모든 중간 상태는 "아직 돌고 있다"로 접는다.
 * REJECTED 는 이 경로에서 생기지 않지만(검수 승인이 곧 승인) 미래에 생겨도 실패로
 * 취급하는 것이 안전하다 — 사용자에게 "성공"으로 보이는 것이 최악이다.
 */
export function summarizeApplyProposal(proposal: {
  id: string;
  status: string;
  executedAt?: Date | string | null;
  errorMessage?: string | null;
  executionResult?: unknown;
}): ApplySummary {
  const outcome: ApplyOutcome =
    proposal.status === "EXECUTED"
      ? "SUCCEEDED"
      : proposal.status === "FAILED" || proposal.status === "REJECTED"
        ? "FAILED"
        : "RUNNING";

  const results = (proposal.executionResult as ExecutionResult | null)?.results ?? [];
  let createdCount = 0;
  let updatedCount = 0;
  for (const entry of results) {
    if (entry.action === "CREATE") createdCount += 1;
    else if (entry.action === "UPDATE") updatedCount += 1;
  }

  const finishedAt = proposal.executedAt
    ? proposal.executedAt instanceof Date
      ? proposal.executedAt.toISOString()
      : String(proposal.executedAt)
    : null;

  return {
    proposalId: proposal.id,
    outcome,
    createdCount,
    updatedCount,
    finishedAt,
    // 성공한 제안에 낡은 errorMessage가 남아 있어도 노출하지 않는다(재시도 후 성공한 경우).
    errorMessage: outcome === "FAILED" ? (proposal.errorMessage ?? null) : null,
  };
}
