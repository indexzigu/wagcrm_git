// /api/assistant 응답을 UI에서 다루기 위한 공용 타입.
// route.ts의 NextResponse.json(...) 페이로드와 형태를 맞춘다.

/**
 * 대상 엔티티 타입 → 한글 라벨. approval-inbox.tsx에 있던 것을 proposal-card.tsx와
 * 공유하기 위해 이 공용 타입 모듈로 추출했다(청사진 §3-#4 "ENTITY_TYPE_LABELS 재사용").
 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  PARTNER: "거래처",
  SELLER: "셀러",
  DEAL: "딜",
  CAMPAIGN: "캠페인",
};

export type AssistantToolCallView = {
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
  evidence: { dataSources: string[]; query: Record<string, unknown> } | null;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "model";
  text: string;
  toolCalls?: AssistantToolCallView[];
  isClarification?: boolean;
  lintWarnings?: string[];
  actionProposalId?: string | null;
  // 채팅 영속화 §2-1/plan-critic #5: 이 턴에 생성된 기안 ID 전부(복수) — GUI 기안
  // 카드가 첫 건만 보고 나머지를 놓치는 사고를 막기 위해 단수 필드와 함께 관통시킨다.
  actionProposalIds?: string[];
  // §1-2 저장 계약: 재수화된 메시지의 toolCalls가 64KB 캡 초과로 data가 제거된 상태인지.
  // 라이브 응답에는 없고(원본 그대로), 재수화 경로에서만 채워진다.
  toolCallsTruncated?: boolean;
  createdAt: string;
};

export type AssistantApiResponse = {
  reply: string;
  toolCalls: AssistantToolCallView[];
  isClarification: boolean;
  actionProposalId: string | null;
  actionProposalIds: string[];
  conversationId: string | null;
  lintWarnings: string[];
  model: string;
  latencyMs: number;
};
