import type { AgentJobRecord } from "@/repositories/agentJobRepository";

/**
 * `GET /api/agent-jobs` 한 페이지 크기. Next App Router route.ts는 GET 등 알려진 이름 외의
 * export를 허용하지 않으므로(`src/app/api/action-proposals/route.ts`와 동일 사유) 이 상수는
 * 라우트 파일이 아닌 여기서 export한다.
 */
export const AGENT_JOBS_PAGE_SIZE = 50;

/** 결재함 「봇 활동」 행. payload.input(봇이 넣은 원문)·origin(슬랙 digest)은 싣지 않는다(§3-C). */
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
};

export function toListItem(job: AgentJobRecord): AgentJobListItem {
  return {
    id: job.id,
    status: job.status,
    operation: job.payload.operation,
    taskType: job.payload.taskType,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    attempt: job.attempt,
    failureCode: job.failureCode,
    resultStatus: job.result?.status ?? null,
    resultSummary: job.result?.resultSummary ?? null,
    actionProposalId: job.result?.actionProposalId ?? null,
  };
}
