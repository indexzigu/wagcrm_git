import type { z } from "zod";

/**
 * 도구 실행 결과 공통 타입. 자유 SQL 금지 — 기존 report/repository 래퍼만 호출한다.
 *
 * error.code:
 * - MISSING_PARAM: 필수 파라미터 누락 (에이전트 루프가 되묻기로 조기종료해야 함)
 * - NOT_FOUND: 조회 대상이 존재하지 않음 (수치 생성 중단)
 * - QUERY_FAILED: 조회 중 예외 발생 (수치 생성 중단)
 */
export type ToolErrorCode = "MISSING_PARAM" | "NOT_FOUND" | "QUERY_FAILED";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
};

export type ToolEvidence = {
  /** 이 결과의 근거가 된 데이터 소스 식별자들 (예: "SalesCampaign", "Deal") */
  dataSources: string[];
  /** 실행된 조회의 파라미터 요약 (감사 추적/딥링크 생성용) */
  query: Record<string, unknown>;
};

/**
 * WRITE 도구가 반환하는 구조화된 "쓰기 의도" (청사진 §0-1).
 *
 * AgentTool.execute(input)에는 userId가 없으므로, WRITE 도구는 실제 쓰기도
 * ActionProposal 기안 생성도 하지 않고 이 intent만 반환한다. userId를 가진
 * /api/assistant route가 runAgent 반환 후 이 intent를 보고 단일 지점에서
 * ActionProposal(WRITE)을 생성 + PENDING_APPROVAL로 전이시킨다.
 */
export type WriteIntent = {
  /** write-executor.WRITE_ACTIONS 화이트리스트 키 (예: "add_entity_memo") */
  action: string;
  /** 화이트리스트 핸들러에 그대로 전달될 args (승인 시점에 argsSchema로 재검증됨) */
  args: Record<string, unknown>;
  /** 승인 카드에 노출할 사람이 읽을 수 있는 요약 */
  summary: string;
  targetEntityType: string;
  targetEntityId: string;
};

export type ToolResult<TData = unknown> =
  | { ok: true; data: TData; evidence: ToolEvidence }
  | { ok: false; error: ToolError; evidence?: ToolEvidence };

export type AgentTool<TInput = any, TData = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<ToolResult<TData>>;
};

/** WRITE 도구 이름 레지스트리 — agent-loop가 이 Set으로 도구 결과에서 writeIntent를 걷어낸다. */
export const WRITE_TOOL_NAMES = new Set<string>([
  "add_entity_memo",
  "change_deal_status",
  "confirm_settlement",
]);

export function missingParam(message: string, query: Record<string, unknown> = {}): ToolResult<never> {
  return {
    ok: false,
    error: { code: "MISSING_PARAM", message },
    evidence: { dataSources: [], query },
  };
}

export function notFound(
  message: string,
  dataSources: string[],
  query: Record<string, unknown> = {}
): ToolResult<never> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message },
    evidence: { dataSources, query },
  };
}

export function queryFailed(
  message: string,
  dataSources: string[] = [],
  query: Record<string, unknown> = {}
): ToolResult<never> {
  return {
    ok: false,
    error: { code: "QUERY_FAILED", message },
    evidence: { dataSources, query },
  };
}

export function ok<TData>(
  data: TData,
  dataSources: string[],
  query: Record<string, unknown> = {}
): ToolResult<TData> {
  return {
    ok: true,
    data,
    evidence: { dataSources, query },
  };
}
