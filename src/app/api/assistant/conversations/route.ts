import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth-context";
import { AssistantConversationRepository } from "@/repositories/assistantConversationRepository";

/**
 * GET /api/assistant/conversations — 본인(createdBy=userId) 대화 목록 최근 30개 조회
 * (Phase 5 채팅 영속화 청사진 §2-2). id·title·updatedAt·메시지수만 반환한다(목록
 * 화면은 미리보기 불필요 — 메시지 전체는 [id] 상세에서만 로드).
 *
 * §5-3 追記(대화 검색): searchParams.q를 트림해 list에 전달한다. q가 없으면 undefined가
 * 그대로 전달되어 repository의 무필터 동작(현 동작)이 유지된다.
 */
export async function GET(request: Request) {
  const authContext = await getAuthContext();
  if (!authContext) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get("q")?.trim();

  const conversations = await AssistantConversationRepository.list(authContext.userId, q);

  return NextResponse.json({ conversations });
}
