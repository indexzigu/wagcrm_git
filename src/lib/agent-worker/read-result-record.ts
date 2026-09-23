import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { serializeJsonFields } from "@/repositories/actionProposalRepository";

/**
 * 봇(agent worker)의 **읽기** 작업 결과를 결재함의 READ 산출물로 남긴다.
 *
 * - 카드 단위 필드(requestType·kind·status·title·resultSummary·dataSources·reviewRequired)는
 *   은퇴한 웹 채팅이 하던 「READ 자동 기록」과 모양이 같다. 다만 `structuredResult`는 이
 *   모듈 전용 봉투 `{ operation, jobId, query, truncated, data }`이므로, 결재함 상세 렌더는
 *   `structuredResult.data`를 풀어서 써야 한다
 *   (설계 정본: docs/private/specs/2026-09-22-assistant-renewal-approval-hub-design.md §3-A).
 * - ⛔ INSERT 만 한다. UPDATE·승인·실행 함수는 여기 없고 들어와서도 안 된다 —
 *   `agent-worker-boundary.contract.test.ts` 가 이 파일을 소스 스캔으로 고정한다.
 * - 실행기(`executor.ts`)에는 `"EXECUTED"` 리터럴을 둘 수 없어(같은 계약) 상태 문자열이
 *   이 모듈에만 있다. READ 산출물은 승인 대상이 아니므로 DRAFT→EXECUTED 로 바로 기록한다
 *   (`ActionProposalRepository.canTransition` 의 READ 직행 전이와 같은 의미).
 */
export const READ_RECORD_ACTOR = "AGENT_WORKER";
export const READ_RECORD_REQUEST_TYPE = "data_query";
/**
 * structuredResult 직렬화 상한(64KB).
 * 채팅 저장 상한(TOOL_CALLS_BYTE_CAP)에서 물려받은 값 — 채팅 은퇴(PR 3)로 이 모듈이 정본.
 */
export const MAX_READ_RESULT_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;

export type ReadResultRecord = {
  /** 결재함 카드 제목(조회 종류 + 요약) */
  title: string;
  /** 사람이 읽는 요약 — 실행기가 봇에게 돌려주는 resultSummary 와 같은 글 */
  resultSummary: string;
  /** 조회 결과 원본(표 렌더용). 상한 초과 시 마커로 대체된다 */
  structuredResult: unknown;
  dataSources: string[];
  /** 조회 조건(딥링크·감사 추적) */
  query: Record<string, unknown>;
};

/** 상한을 넘으면 데이터 대신 마커를 남긴다 — 잘린 JSON 은 파서를 깨뜨리고 표를 반쯤 그린다. */
export function boundStructuredResult(value: unknown): { value: unknown; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes <= MAX_READ_RESULT_BYTES) return { value, truncated: false };
  return { value: { truncated: true, bytes }, truncated: true };
}

export async function recordReadResult(
  operation: string,
  record: ReadResultRecord,
  now: Date,
  options?: { jobId?: string },
): Promise<string> {
  const bounded = boundStructuredResult(record.structuredResult);
  const structuredResult = {
    operation,
    jobId: options?.jobId ?? null,
    query: record.query,
    truncated: bounded.truncated,
    data: bounded.value,
  } as Prisma.InputJsonValue;
  return getPrisma().$transaction(async (tx) => {
    const created = await tx.actionProposal.create({
      data: serializeJsonFields({
        requestType: READ_RECORD_REQUEST_TYPE,
        kind: "READ",
        status: "EXECUTED",
        title: record.title.slice(0, MAX_TITLE_CHARS),
        resultSummary: record.resultSummary,
        dataSources: record.dataSources,
        structuredResult,
        reviewRequired: false,
        createdBy: READ_RECORD_ACTOR,
        executedBy: READ_RECORD_ACTOR,
        executedAt: now,
      }),
    });
    await tx.actionProposalEvent.create({
      data: {
        proposalId: created.id,
        fromStatus: "DRAFT",
        toStatus: "EXECUTED",
        actor: READ_RECORD_ACTOR,
        note: "agent worker 조회 결과 기록",
      },
    });
    return created.id;
  });
}
