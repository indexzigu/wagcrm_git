import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
// §5-3: 대화 검색 — Postgres insensitive / SQLite plain 검색을 이원화 처리하는 기존
// 유틸을 그대로 재사용한다(신규 구현 금지, 설계 확정본 그대로).
import { containsSearch } from "@/lib/prisma-search";

// 어시스턴트 채팅 영속화 저장소 (Phase 5 청사진 §1/§4-3).
//
// Json 이원화 직렬화는 ActionProposalRepository(serializeJsonField/deserializeJsonField)와
// 동일한 패턴이다. actionProposalRepository는 export된 순수 함수를 제공하므로 재사용하되,
// 이 파일 전용 이름(serializeJsonValue/deserializeJsonValue)으로 재노출해 두 저장소 간
// import 방향이 뒤엉키지 않게 한다(actionProposalRepository는 이 파일을 몰라도 된다).
import { serializeJsonField, deserializeJsonField } from "./actionProposalRepository";

export type AssistantToolCallRecord = {
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
  evidence: { dataSources: string[]; query: Record<string, unknown> } | null;
};

// §1-2: 메시지당 직렬화 64KB 캡. 초과 시 각 toolCall의 data 필드만 제거한다.
const TOOL_CALLS_BYTE_CAP = 64 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

/**
 * §1-2 저장 계약: toolCalls를 provider(SQLite/Postgres)에 맞게 직렬화하며, JSON
 * 문자열 길이가 64KB를 초과하면 각 toolCall의 data 필드를 제거(toolName·args·ok·
 * error·evidence는 유지)하고 truncated=true를 반환한다.
 *
 * 순수 함수로 분리해 DB 없이 유닛테스트로 캡 초과/미만 양쪽을 검증할 수 있게 한다.
 */
export function serializeToolCalls(
  toolCalls: AssistantToolCallRecord[] | null | undefined
): { value: unknown; truncated: boolean } {
  if (toolCalls === null || toolCalls === undefined) {
    return { value: null, truncated: false };
  }

  const raw = JSON.stringify(toolCalls);
  if (byteLength(raw) <= TOOL_CALLS_BYTE_CAP) {
    return { value: serializeJsonField(toolCalls), truncated: false };
  }

  // 캡 초과 — data 필드만 제거하고 나머지 근거 필드는 그대로 유지한다.
  const truncatedCalls = toolCalls.map((call) => ({
    toolName: call.toolName,
    args: call.args,
    ok: call.ok,
    data: null,
    error: call.error,
    evidence: call.evidence,
  }));

  return { value: serializeJsonField(truncatedCalls), truncated: true };
}

export function deserializeToolCalls(value: unknown): AssistantToolCallRecord[] | null {
  return deserializeJsonField<AssistantToolCallRecord[]>(value);
}

// database-review Major: text(user/model 본문)도 무제한이면 findWithMessages가 대화 전체를
// 로드할 때 페이로드/메모리가 무한 성장한다. toolCalls 캡(§1-2)과 동일한 사상으로 본문에도
// 상한을 둔다 — 100K자(UTF-8 기준 최대 ~400KB)면 정상 대화는 전부 통과하고 폭주만 걸러진다.
const TEXT_CHAR_CAP = 100_000;
const TEXT_TRUNCATION_MARKER = "\n…(본문이 길이 상한을 초과해 잘렸습니다)";

/** 본문 텍스트를 저장 상한으로 절단한다(순수 함수 — DB 없이 테스트 가능). */
export function clampMessageText(text: string): string {
  if (text.length <= TEXT_CHAR_CAP) return text;
  return text.slice(0, TEXT_CHAR_CAP) + TEXT_TRUNCATION_MARKER;
}

// actionProposalIds는 toolCalls보다 훨씬 작은 문자열 배열이라 별도 캡 없이 동일한
// 이원화 직렬화만 적용한다.
export function serializeActionProposalIds(ids: string[] | null | undefined): unknown {
  if (ids === null || ids === undefined) return null;
  return serializeJsonField(ids);
}

export function deserializeActionProposalIds(value: unknown): string[] | null {
  return deserializeJsonField<string[]>(value);
}

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: Date;
  messageCount: number;
};

export type AssistantChatMessageView = {
  id: string;
  conversationId: string;
  role: "user" | "model";
  text: string;
  toolCalls: AssistantToolCallRecord[] | null;
  toolCallsTruncated: boolean;
  actionProposalIds: string[] | null;
  createdAt: Date;
};

export class AssistantConversationRepository {
  /**
   * 신규 대화 생성. title은 호출부(route.ts)가 첫 user 메시지 앞 80자로 만들어 넘긴다
   * (§2-1 — 이 저장소는 절삭 로직을 모르고 그대로 저장만 한다).
   */
  static async create(data: { createdBy: string; title?: string | null }) {
    return getPrisma().assistantConversation.create({
      data: {
        createdBy: data.createdBy,
        title: data.title ?? null,
      },
    });
  }

  /**
   * 본인(createdBy) 소유 대화 최근 30개 — id·title·updatedAt·메시지수(§2-2).
   * 메시지 전체를 불러오지 않고 _count로 개수만 집계한다(목록 화면은 미리보기 불필요).
   *
   * §5-3 追記(대화 검색): query가 트림 후 비어있지 않으면 소유 스코프(createdBy)는 유지한
   * 채 title 또는 본문(messages.some.text) 매칭 OR 조건을 where에 추가한다. query가
   * 없거나 공백뿐이면 현 동작(무필터) 그대로 — 기존 무인자 호출과 하위호환.
   */
  static async list(createdBy: string, query?: string): Promise<AssistantConversationSummary[]> {
    const trimmedQuery = query?.trim();
    const where =
      trimmedQuery && trimmedQuery.length > 0
        ? {
            createdBy,
            OR: [
              { title: containsSearch(trimmedQuery) },
              { messages: { some: { text: containsSearch(trimmedQuery) } } },
            ],
          }
        : { createdBy };

    const rows = await getPrisma().assistantConversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 30,
      include: {
        _count: { select: { messages: true } },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt,
      messageCount: row._count?.messages ?? 0,
    }));
  }

  /**
   * 대화+메시지 전체(createdAt asc) 조회. createdBy를 결과에 포함해 호출부(route)가
   * 소유 검증(createdBy===userId)에 바로 쓸 수 있게 한다 — 이 함수 자체는 권한을
   * 판단하지 않는다(단일 책임: 조회만).
   */
  static async findWithMessages(conversationId: string): Promise<{
    id: string;
    createdBy: string;
    title: string | null;
    messages: AssistantChatMessageView[];
  } | null> {
    const row = await getPrisma().assistantConversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!row) return null;

    return {
      id: row.id,
      createdBy: row.createdBy,
      title: row.title,
      messages: (row.messages as any[]).map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        role: m.role,
        text: m.text,
        toolCalls: deserializeToolCalls(m.toolCalls),
        toolCallsTruncated: !!m.toolCallsTruncated,
        actionProposalIds: deserializeActionProposalIds(m.actionProposalIds),
        createdAt: m.createdAt,
      })),
    };
  }

  /**
   * user 턴 + model 턴 두 건을 하나의 트랜잭션으로 저장하고, 대화 updatedAt을 갱신한다.
   * (§2-1 — 영속화 실패는 route.ts의 m4 격리 try/catch가 감싼다. 이 함수 자체는
   * 실패를 삼키지 않고 그대로 throw한다.)
   */
  static async appendTurns(
    conversationId: string,
    turns: {
      userText: string;
      modelText: string;
      toolCalls: AssistantToolCallRecord[];
      actionProposalIds: string[];
    }
  ): Promise<{ truncated: boolean }> {
    const { value: serializedToolCalls, truncated } = serializeToolCalls(turns.toolCalls);
    const serializedIds = serializeActionProposalIds(turns.actionProposalIds);

    await getPrisma().$transaction(async (tx: any) => {
      await tx.assistantChatMessage.create({
        data: {
          conversationId,
          role: "user",
          text: clampMessageText(turns.userText),
        },
      });

      await tx.assistantChatMessage.create({
        data: {
          conversationId,
          role: "model",
          text: clampMessageText(turns.modelText),
          toolCalls: serializedToolCalls,
          toolCallsTruncated: truncated,
          actionProposalIds: serializedIds,
        },
      });

      await tx.assistantConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
    });

    return { truncated };
  }

  /**
   * §5-1: 대화 삭제 — 소유 스코프 원자 삭제. id와 createdBy를 동시에 where 조건에 걸어
   * deleteMany를 호출하면 "존재 확인 후 삭제" 2단계 대신 단일 원자 연산이 되어, 확인과
   * 삭제 사이에 타인이 끼어드는 레이스가 원천적으로 불가능하다(레이스-세이프).
   * count===0이면 대상이 없었거나(부재) 타인 소유였다는 뜻 — 호출부(route)는 이 두 경우를
   * 구분하지 않고 동일한 404로 응답해 존재 여부를 노출하지 않는다.
   * 메시지는 스키마의 onDelete: Cascade가 자동 정리한다(스키마 무변경).
   */
  static async deleteOwned(id: string, createdBy: string): Promise<{ deleted: boolean }> {
    const result = await getPrisma().assistantConversation.deleteMany({
      where: { id, createdBy },
    });
    return { deleted: result.count > 0 };
  }

  /**
   * §5-2: 대화 이름 바꾸기 — deleteOwned와 동일한 소유 스코프 원자 패턴(updateMany의
   * count로 판정). id와 createdBy를 동시에 where 조건에 걸어 "존재 확인 후 수정" 2단계
   * 대신 단일 원자 연산으로 만들어 레이스를 원천 차단한다. count===0이면 대상이 없었거나
   * 타인 소유였다는 뜻 — 호출부(route)는 deleteOwned와 동일하게 두 경우를 구분하지 않고
   * 동일한 404로 응답한다(존재 여부 비노출).
   */
  static async renameOwned(id: string, createdBy: string, title: string): Promise<{ renamed: boolean }> {
    const result = await getPrisma().assistantConversation.updateMany({
      where: { id, createdBy },
      data: { title },
    });
    return { renamed: result.count > 0 };
  }
}

// isSqliteDatabaseUrl은 이 파일에서 직접 쓰지 않지만(serializeJsonField 내부가 판단),
// 향후 이 저장소 전용 분기가 필요할 때를 대비해 재노출해 둔다.
export { isSqliteDatabaseUrl };
