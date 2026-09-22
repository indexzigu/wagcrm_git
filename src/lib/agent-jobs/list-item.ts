import type { AgentJobListRow } from "@/repositories/agentJobRepository";

/**
 * `GET /api/agent-jobs` 한 페이지 크기. Next App Router route.ts는 GET 등 알려진 이름 외의
 * export를 허용하지 않으므로(`src/app/api/action-proposals/route.ts`와 동일 사유) 이 상수는
 * 라우트 파일이 아닌 여기서 export한다.
 */
export const AGENT_JOBS_PAGE_SIZE = 50;

/**
 * 결재함 「봇 활동」 행. payload.input(봇이 넣은 원문)·origin(슬랙 digest)은 싣지 않는다(§3-C).
 * `payloadUnreadable`이 true면 저장된 payload가 poison row라 operation/taskType을
 * 복원하지 못했다는 뜻이다(`AgentJobRepository.listRecent`의 degraded 행).
 */
export type AgentJobListItem = {
  id: string;
  status: string;
  operation: string;
  taskType: string;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  failureCode: string | null;
  resultStatus: string | null;
  resultSummary: string | null;
  actionProposalId: string | null;
  payloadUnreadable: boolean;
};

export function toListItem(row: AgentJobListRow): AgentJobListItem {
  if ("degraded" in row) {
    return {
      id: row.id,
      status: row.status,
      operation: "unknown",
      taskType: "unknown",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      attempt: row.attempt,
      failureCode: row.failureCode,
      resultStatus: null,
      resultSummary: null,
      actionProposalId: null,
      payloadUnreadable: true,
    };
  }

  return {
    id: row.id,
    status: row.status,
    operation: row.payload.operation,
    taskType: row.payload.taskType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attempt: row.attempt,
    failureCode: row.failureCode,
    resultStatus: row.result?.status ?? null,
    resultSummary: row.result?.resultSummary ?? null,
    actionProposalId: row.result?.actionProposalId ?? null,
    payloadUnreadable: false,
  };
}
