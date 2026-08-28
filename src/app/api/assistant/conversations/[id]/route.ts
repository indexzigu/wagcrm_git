import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth-context";
import { AssistantConversationRepository } from "@/repositories/assistantConversationRepository";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/assistant/conversations/[id] — 소유 검증 후 메시지 전체(createdAt asc,
 * toolCalls·actionProposalIds 역직렬화 포함) 조회 (Phase 5 채팅 영속화 청사진 §2-2).
 * 타인 소유·부재는 동일한 404로 응답한다(존재 여부 비노출 — /api/assistant의 선행
 * 하드 게이트와 동일한 원칙).
 */
export async function GET(_request: Request, context: Context) {
  const authContext = await getAuthContext();
  if (!authContext) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const { id } = await context.params;

  const conversation = await AssistantConversationRepository.findWithMessages(id);
  if (!conversation || conversation.createdBy !== authContext.userId) {
    return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages,
  });
}

/**
 * DELETE /api/assistant/conversations/[id] — 소유 스코프 원자 삭제 (§5-1 追記).
 * deleteOwned가 { id, createdBy } 동시 조건 deleteMany의 count로 판정하므로 레이스-세이프.
 * count===0(타인 소유·부재)은 GET과 동일하게 404로 통일해 존재 여부를 노출하지 않는다.
 * 메시지는 CASCADE로 자동 정리되고, ActionProposal·ActivityLog는 별개 엔티티라 삭제되지
 * 않는다(감사 기록 보존 — 대화는 뷰, 기안·감사가 진실원천).
 */
export async function DELETE(_request: Request, context: Context) {
  const authContext = await getAuthContext();
  if (!authContext) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const { id } = await context.params;

  const { deleted } = await AssistantConversationRepository.deleteOwned(id, authContext.userId);
  if (!deleted) {
    return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/assistant/conversations/[id] — 대화 이름 바꾸기 (§5-2 追記, DELETE와 동일 파일·
 * auth 관례). body { title: string }을 트림 후 1~120자 검증(빈 문자열·초과 400) 하고,
 * renameOwned(소유 스코프 원자 updateMany, count 판정)가 false면 DELETE와 동일하게 404로
 * 통일한다(존재 여부 비노출). body 파싱 실패도 400으로 처리한다.
 */
export async function PATCH(request: Request, context: Context) {
  const authContext = await getAuthContext();
  if (!authContext) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const { id } = await context.params;

  let body: { title?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "제목은 1~120자여야 합니다." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length === 0 || title.length > 120) {
    return NextResponse.json({ error: "제목은 1~120자여야 합니다." }, { status: 400 });
  }

  const { renamed } = await AssistantConversationRepository.renameOwned(id, authContext.userId, title);
  if (!renamed) {
    return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
