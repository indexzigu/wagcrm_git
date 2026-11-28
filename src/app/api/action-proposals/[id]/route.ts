import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  ActionProposalRepository,
  deserializeJsonField,
  isFailedCloseEvent,
} from "@/repositories/actionProposalRepository";
import { resolveEntityLabel, resolveProposalArgLabels } from "@/lib/agent/resolve-entity-label";
import { detectAlreadyApplied } from "@/lib/agent/already-applied";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/action-proposals/[id] — 상세(events 포함, entity명 해석) (청사진 §2).
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  const proposal = await ActionProposalRepository.findById(id, { events: true });
  if (!proposal) {
    return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
  }

  const targetEntityName = await resolveEntityLabel(
    proposal.targetEntityType,
    proposal.targetEntityId
  );

  // payload/executionResult는 SQLite에서 문자열로 저장되므로 UI가 payload.action 등을 읽으려면
  // 역직렬화해야 한다(Postgres 객체엔 no-op). 안 하면 dev:local에서 카드 라벨이 "알 수 없는 액션"이 된다.
  // structuredResult/dataSources/evidence도 같은 이유로 역직렬화한다 — 결재함 상세(§3-B)가
  // READ 봉투 `{operation, jobId, query, truncated, data}`를 읽는다.
  const payload = deserializeJsonField(proposal.payload);
  // [캘린더수집] 새 회차 기안은 대상 캠페인이 없어 배지로 이름을 못 보인다 — args 의 셀러·판매 조건을 푼다.
  const argLabels = await resolveProposalArgLabels(payload);
  // 실패 기안이면 다른 경로로 이미 반영됐는지 — 상세 카드도 목록 카드처럼 「반영완료」 배지와 종결 버튼을 띄운다.
  const alreadyApplied = proposal.status === "FAILED" ? await detectAlreadyApplied(payload, getPrisma()) : undefined;
  // 반려 기안이 오너가 실패에서 종결한 것이면 상세 배지도 「종결됨」이다(목록의 `closedFromFailure` 와 같은 판정).
  const closedFromFailure = proposal.status === "REJECTED" ? (proposal.events ?? []).some(isFailedCloseEvent) : undefined;

  return NextResponse.json({
    ...proposal,
    payload,
    // 캘린더 출신 카드의 「원본 일정」 — sqlite 문자열 저장 대응(위와 같은 이유).
    sourceRef: deserializeJsonField(proposal.sourceRef),
    argLabels,
    executionResult: deserializeJsonField(proposal.executionResult),
    structuredResult: deserializeJsonField(proposal.structuredResult),
    dataSources: deserializeJsonField(proposal.dataSources),
    evidence: deserializeJsonField(proposal.evidence),
    targetEntityName,
    ...(alreadyApplied === undefined ? {} : { alreadyApplied }),
    ...(closedFromFailure === undefined ? {} : { closedFromFailure }),
  });
}
