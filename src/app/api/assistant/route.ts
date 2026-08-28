import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAgentLaneUserId } from "@/lib/agent-lane";
import { runAgent, type AgentHistoryTurn } from "@/lib/agent/agent-loop";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import { getRequestTypeForAction, isAutoApprovable } from "@/lib/agent/approval-policy";
import { executeWriteAction } from "@/lib/agent/write-executor";
import { applyWriteActionEffects } from "@/lib/agent/write-action-effects";
import { getPrisma } from "@/lib/prisma";
import { AssistantConversationRepository } from "@/repositories/assistantConversationRepository";

// Prisma Json 입력 타입은 구조적으로 좁은 InputJsonValue만 받으므로, 도구 실행 결과처럼
// 형태가 느슨한 객체(Date 등 비-JSON 값 포함 가능)는 직렬화 왕복으로 한 번만 JSON-safe 값으로
// 강제 변환한다. (SQLite/Postgres 이원화 문자열화는 ActionProposalRepository.serializeJsonFields가
// 별도로 담당하므로 여기서는 그 처리를 중복하지 않는다.)
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null));
}

// (Next 16 cacheComponents와 `export const dynamic` 비호환 — auth 사용으로 이미 동적 라우트라 불필요)

// M1+M2: history는 토큰 폭발/페이로드 방어를 위해 상한을 둔다.
// 400 거부가 아니라 절삭(오래된 턴부터 제거, 각 text는 뒤에서부터 4000자 유지)으로 UX를 보호한다.
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_TEXT_LENGTH = 4000;

// 채팅 영속화 §1: 신규 대화 title은 첫 user 메시지 앞 80자.
const CONVERSATION_TITLE_LENGTH = 80;

const historyTurnSchema = z.object({
  role: z.enum(["user", "model"]),
  text: z.string(),
});

type AssistantRequestBody = {
  message?: string;
  history?: unknown;
  conversationId?: string;
};

function isValidHistory(history: unknown): history is AgentHistoryTurn[] {
  if (!Array.isArray(history)) return false;
  return history.every((turn) => historyTurnSchema.safeParse(turn).success);
}

/**
 * history 배열을 최근 MAX_HISTORY_TURNS턴으로 절삭하고, 각 턴의 text를 MAX_HISTORY_TEXT_LENGTH자로
 * 자른다. 400 거부 대신 절삭하는 이유: 조회 전용 어시스턴트에서 과거 대화가 길어졌다고 요청 자체를
 * 막으면 사용자 경험이 나빠지므로, 최신 컨텍스트만 유지한 채 계속 진행한다.
 */
function clampHistory(history: AgentHistoryTurn[]): AgentHistoryTurn[] {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  return recent.map((turn) => ({
    role: turn.role,
    text:
      turn.text.length > MAX_HISTORY_TEXT_LENGTH
        ? turn.text.slice(-MAX_HISTORY_TEXT_LENGTH)
        : turn.text,
  }));
}

/**
 * 이번 턴 도구 호출들의 dataSources를 합쳐 ActionProposal.dataSources로 기록한다.
 */
function collectDataSources(toolCalls: Awaited<ReturnType<typeof runAgent>>["toolCalls"]): string[] {
  const set = new Set<string>();
  for (const call of toolCalls) {
    const sources = call.result.ok
      ? call.result.evidence.dataSources
      : call.result.evidence?.dataSources ?? [];
    for (const s of sources) set.add(s);
  }
  return Array.from(set);
}

export async function POST(request: Request) {
  // 미들웨어(src/lib/supabase/middleware.ts)가 1차 방어이지만, 라우트에서도 이중으로
  // getUser()를 확인한다 (청사진 R4: /api/assistant가 미들웨어 매처에서 누락될 가능성 대비).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 로그인 사용자 우선, 없으면 비프로덕션 에이전트 레인(B4-1)만 synthetic 식별자 허용.
  const agentLaneUserId = getAgentLaneUserId(request);
  const userId = user?.id ?? agentLaneUserId;
  if (!userId) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  // 채팅 영속화 §2-1(plan-critic #1): 에이전트 레인 호출은 모두 "agent-preview" 한 합성
  // 식별자를 공유한다 — 이 값으로 저장하면 서로 다른 레인 세션이 같은 대화 버킷을
  // 공유 열람하게 되는 누출이 발생한다. 레인이면 영속화 블록 전체를 스킵한다
  // (conversationId 수용조차 하지 않음 — 아래에서 body.conversationId를 무시).
  const isAgentLane = !user?.id && agentLaneUserId !== null;

  let body: AssistantRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message가 필요합니다." }, { status: 400 });
  }

  const history = clampHistory(isValidHistory(body.history) ? body.history : []);

  // 채팅 영속화 §2-1: 소유 검증은 runAgent 이전 하드 게이트(plan-critic #4) — 지정된
  // conversationId의 createdBy≠userId 또는 부재면 어떤 부작용도 없이 즉시 404(에이전트
  // 실행·자동승인·기안 생성 전부 미발화). 에이전트 레인은 conversationId를 아예 수용하지
  // 않는다(위 isAgentLane 참고).
  const requestedConversationId =
    !isAgentLane && typeof body.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : null;

  let conversationId: string | null = null;
  if (requestedConversationId) {
    const existing = await AssistantConversationRepository.findWithMessages(requestedConversationId);
    if (!existing || existing.createdBy !== userId) {
      // 존재 여부 자체를 노출하지 않기 위해 "부재"와 "타인 소유"를 동일한 404로 응답한다.
      return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });
    }
    conversationId = existing.id;
  }

  try {
    const result = await runAgent(message, history);

    // m4: ActionProposal 기록(create→transition)은 조회 응답 자체와 별개의 부가 작업이다.
    // 기록이 실패해도 이미 계산된 finalText(조회 답변)를 사용자에게 반드시 전달해야 하므로,
    // 이 블록은 별도 try/catch로 격리해 실패를 삼키고 actionProposalId=null로 정상 응답한다.
    let actionProposalId: string | null = null;
    // 채팅 영속화 §2-1: 이번 턴에 생성된 기안 ID 전부(WRITE 블록 createdIds 또는 READ
    // 자동-EXECUTED 단건) — 함수 스코프로 끌어올려 응답의 actionProposalIds와 메시지
    // 저장(appendTurns) 양쪽에서 재사용한다.
    let turnActionProposalIds: string[] = [];

    // 청사진 §0-1/§0-2: 이번 턴에 writeIntent가 하나라도 있으면 READ 자동-EXECUTED
    // 블록은 건너뛰고, writeIntent별로 WRITE 기안(PENDING_APPROVAL)을 생성한다.
    // userId를 가진 이 route가 기안 생성의 단일 지점이다 — 도구(execute)는 userId를
    // 모르므로 writeIntent만 반환했을 뿐 아직 아무 기안도 만들지 않았다.
    //
    // Phase 5 자동승인 화이트리스트 청사진 v2 §3-1: 복수 intent 턴(자동+수동 혼재)에서
    // intent N의 실패가 intent N+1 처리를 막지 않도록, 각 intent를 자체 try/catch로 감싼다
    // (기존 전체-블록 try/catch는 "기안 기록 실패해도 조회 응답은 정상" 격리를 위해 유지).
    if (result.writeIntents.length > 0) {
      try {
        const createdIds: string[] = [];
        for (const intent of result.writeIntents) {
          // security-review M1: per-intent 실패 시 어느 기안·어느 단계인지 추적 가능한 구조화
          // 로그를 남긴다. create 성공 전 실패 = DB 기록 없음(§3-1 수용), 이후 단계 실패는
          // proposalId로 인박스에서 수습 가능(PENDING 잔류 등) — 로그가 그 추적 열쇠다.
          let proposalIdForLog: string | null = null;
          let stageForLog: "create" | "submit" | "auto-approve" = "create";
          try {
            const requestType = getRequestTypeForAction(intent.action);
            const autoOk = isAutoApprovable(requestType, "WRITE");

            const created = await ActionProposalRepository.create({
              requestType,
              kind: "WRITE",
              status: "DRAFT",
              title: intent.summary.slice(0, 200),
              resultSummary: intent.summary,
              payload: toJsonValue({ action: intent.action, args: intent.args }),
              targetEntityType: intent.targetEntityType,
              targetEntityId: intent.targetEntityId,
              reviewRequired: !autoOk,
              createdBy: userId,
              llmModel: result.model,
              promptTokens: result.usage?.promptTokenCount ?? null,
              completionTokens: result.usage?.candidatesTokenCount ?? null,
              latencyMs: result.latencyMs,
            });

            proposalIdForLog = created.id;
            stageForLog = "submit";

            await ActionProposalRepository.transition(created.id, "PENDING_APPROVAL", {
              actor: userId,
              note: "사용자 요청에 따른 WRITE 기안 상신, 관리자 승인 대기",
            });

            createdIds.push(created.id);
            stageForLog = "auto-approve";

            if (autoOk) {
              // §3: autoOk=true — PENDING_APPROVAL→APPROVED(actor="AGENT")→EXECUTED(tx 원자화)를
              // 상태기계 그대로 경유한다(canTransition·approve route 무변경 — DRAFT→EXECUTED 직행 없음).
              await ActionProposalRepository.transition(created.id, "APPROVED", {
                actor: "AGENT",
                note: "approval.rules.json autoApprove 매칭: 자동승인",
                expectedFrom: "PENDING_APPROVAL",
              });

              // 커밋된 실행 결과 — 커밋 뒤 후속 처리(캐시 무효화·캘린더)에 쓴다.
              // 롤백된 실행에는 후속 처리를 하지 않으려고 트랜잭션 밖에 둔다.
              let committedResult: Awaited<ReturnType<typeof executeWriteAction>> | null = null;
              try {
                const prisma = getPrisma();
                committedResult = await prisma.$transaction(async (tx) => {
                  const execResult = await executeWriteAction(intent.action, intent.args, "AGENT", tx);
                  await ActionProposalRepository.transition(created.id, "EXECUTED", {
                    actor: "AGENT",
                    note: `자동 실행 완료: ${execResult.summary}`,
                    data: {
                      executedBy: "AGENT",
                      executedAt: new Date(),
                      executionResult: execResult,
                      executedRefType: execResult.refType,
                      executedRefId: execResult.refId,
                    },
                    expectedFrom: "APPROVED",
                    tx,
                  });
                  return execResult;
                });
              } catch (execErr) {
                // 실행 throw 시 tx 전체 롤백(APPROVED 유지) → 별도 트랜잭션으로 APPROVED→FAILED 기록.
                const message = execErr instanceof Error ? execErr.message : String(execErr);
                await ActionProposalRepository.transition(created.id, "FAILED", {
                  actor: "AGENT",
                  note: "자동 실행 중 오류: 실행 및 EXECUTED 전이 전체 롤백됨(부분반영 없음)",
                  data: { errorMessage: message },
                  expectedFrom: "APPROVED",
                });
              }

              // 승인 버튼 경로와 같은 커밋 후속 처리 — 캐시 무효화 + (정산 확정이면)
              // 캘린더 재동기화. 이게 빠지면 DB 는 바뀌었는데 대시보드·정산 목록은 다음
              // 만료까지 옛 값을 보여준다. 실패해도 던지지 않으므로 FAILED 오분류가 없다.
              // (오늘 자동승인 대상은 add_entity_memo 뿐이라 무효화 대상이 실제로는 비지만,
              //  approval.rules.json 이 넓어지는 순간 이 줄이 유일한 방어선이다.)
              if (committedResult) {
                applyWriteActionEffects(intent.action, committedResult);
              }
            }
          } catch (intentErr) {
            // §3-1: 이 intent의 기안 생성/전이 실패가 다음 intent 처리를 막지 않는다(per-intent 격리).
            // security-review M1: 단계·action·proposalId를 구조화해 자동경로 실패를 집계·추적
            // 가능하게 한다 (stage=submit 실패면 DRAFT 잔류, auto-approve 실패면 PENDING 잔류
            // 가능 — 인박스에서 수습하되 이 로그가 어느 기안인지 알려준다).
            console.error(
              `[POST /api/assistant] WRITE intent 처리 실패 (다음 intent는 계속 진행) stage=${stageForLog} action=${intent.action} proposalId=${proposalIdForLog ?? "(미생성)"}:`,
              intentErr
            );
          }
        }
        // 단수 actionProposalId(첫 건)는 기존 하위호환 그대로 유지하고, 채팅 영속화
        // §2-1(GUI 기안 카드 선행 요구)를 위해 복수 전체는 turnActionProposalIds에 담아
        // 응답의 actionProposalIds와 메시지 저장 양쪽에서 쓴다.
        actionProposalId = createdIds[0] ?? null;
        turnActionProposalIds = createdIds;
      } catch (recordErr) {
        console.error("[POST /api/assistant] WRITE ActionProposal 기록 실패 (조회 응답은 정상 진행):", recordErr);
        actionProposalId = null;
      }
    } else if (result.toolCalls.length > 0 && !result.isClarification) {
      try {
        const dataSources = collectDataSources(result.toolCalls);
        const firstFailedCall = result.toolCalls.find((call) => !call.result.ok);
        const firstFailedMessage =
          firstFailedCall && !firstFailedCall.result.ok ? firstFailedCall.result.error.message : null;

        const created = await ActionProposalRepository.create({
          requestType: "data_query",
          kind: "READ",
          status: "DRAFT",
          title: message.slice(0, 200),
          resultSummary: result.finalText,
          dataSources,
          assumptions: result.lintWarnings.length > 0 ? { lintWarnings: result.lintWarnings } : undefined,
          structuredResult: toJsonValue(
            result.toolCalls.map((call) => ({
              toolName: call.toolName,
              args: call.args,
              ok: call.result.ok,
            }))
          ),
          evidence: toJsonValue(
            result.toolCalls.map((call) => ({
              toolName: call.toolName,
              evidence: call.result.ok ? call.result.evidence : call.result.evidence ?? null,
            }))
          ),
          reviewRequired: false,
          createdBy: userId,
          llmModel: result.model,
          promptTokens: result.usage?.promptTokenCount ?? null,
          completionTokens: result.usage?.candidatesTokenCount ?? null,
          latencyMs: result.latencyMs,
          errorMessage: firstFailedMessage,
        });

        const executed = await ActionProposalRepository.transition(created.id, "EXECUTED", {
          actor: "AGENT",
          note: "READ 산출물: 도구 실행 완료 즉시 자동 승인 (approval.rules.json data_query)",
          data: { executedAt: new Date(), executedBy: "AGENT" },
        });

        actionProposalId = executed.id;
        turnActionProposalIds = [executed.id];
      } catch (recordErr) {
        console.error("[POST /api/assistant] ActionProposal 기록 실패 (조회 응답은 정상 진행):", recordErr);
        actionProposalId = null;
      }
    }

    const toolCallsForResponse = result.toolCalls.map((call) => ({
      toolName: call.toolName,
      args: call.args,
      ok: call.result.ok,
      data: call.result.ok ? call.result.data : null,
      error: call.result.ok ? null : call.result.error,
      evidence: call.result.ok ? call.result.evidence : call.result.evidence ?? null,
    }));

    // 채팅 영속화 §2-1/m4: 에이전트 레인은 애초에 conversationId를 만들지 않았으므로
    // (requestedConversationId=null 고정) 이 블록에서 신규 생성도 건너뛴다. 영속화
    // 실패(대화 생성·턴 저장 어느 쪽이든)는 조회 응답 자체를 깨지 않고 conversationId만
    // null로 남긴다 — 다음 턴에 재생성된다.
    if (!isAgentLane) {
      try {
        if (!conversationId) {
          const created = await AssistantConversationRepository.create({
            createdBy: userId,
            title: message.slice(0, CONVERSATION_TITLE_LENGTH),
          });
          conversationId = created.id;
        }

        await AssistantConversationRepository.appendTurns(conversationId, {
          userText: message,
          modelText: result.finalText,
          toolCalls: toolCallsForResponse,
          actionProposalIds: turnActionProposalIds,
        });
      } catch (persistErr) {
        console.error("[POST /api/assistant] 채팅 영속화 실패 (조회 응답은 정상 진행, m4):", persistErr);
        conversationId = null;
      }
    }

    return NextResponse.json({
      reply: result.finalText,
      toolCalls: toolCallsForResponse,
      isClarification: result.isClarification,
      actionProposalId,
      actionProposalIds: turnActionProposalIds,
      conversationId,
      lintWarnings: result.lintWarnings,
      model: result.model,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    // m6+m7: 500 응답은 고정 문구만 노출하고, Gemini 원문/Prisma 에러 등 내부 정보는
    // 서버 로그에만 남긴다 (에러 메시지에 내부 구현/쿼리 정보가 섞여 나갈 수 있으므로).
    console.error("[POST /api/assistant] Error:", err);
    return NextResponse.json({ error: "요청 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
