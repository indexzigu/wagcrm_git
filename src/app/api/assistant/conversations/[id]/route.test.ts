/**
 * GET /api/assistant/conversations/[id] — 소유 검증 후 메시지 전체(createdAt asc) 조회
 * (Phase 5 청사진 §2-2/§5). 타인 소유·부재는 동일한 404(존재 비노출).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthContextMock = vi.fn();
const findWithMessagesMock = vi.fn();
const deleteOwnedMock = vi.fn();
const renameOwnedMock = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => getAuthContextMock(...args),
}));

vi.mock("@/repositories/assistantConversationRepository", () => ({
  AssistantConversationRepository: {
    findWithMessages: (...args: unknown[]) => findWithMessagesMock(...args),
    deleteOwned: (...args: unknown[]) => deleteOwnedMock(...args),
    renameOwned: (...args: unknown[]) => renameOwnedMock(...args),
  },
}));

import { GET, DELETE, PATCH } from "./route";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/assistant/conversations/[id]", () => {
  beforeEach(() => {
    getAuthContextMock.mockReset();
    findWithMessagesMock.mockReset();
    deleteOwnedMock.mockReset();
    getAuthContextMock.mockResolvedValue({ userId: "user-1", email: "a@b.com", role: "admin" });
  });

  it("인증되지 않으면 401을 반환한다", async () => {
    getAuthContextMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/assistant/conversations/conv-1"), makeContext("conv-1"));

    expect(res.status).toBe(401);
    expect(findWithMessagesMock).not.toHaveBeenCalled();
  });

  it("존재하지 않는 대화면 404를 반환한다", async () => {
    findWithMessagesMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/assistant/conversations/no-such"), makeContext("no-such"));

    expect(res.status).toBe(404);
  });

  it("타인 소유 대화면 404를 반환한다(부재와 동일 응답 — 존재 비노출)", async () => {
    findWithMessagesMock.mockResolvedValue({
      id: "conv-other",
      createdBy: "other-user",
      title: "제목",
      messages: [],
    });

    const res = await GET(new Request("http://localhost/api/assistant/conversations/conv-other"), makeContext("conv-other"));

    expect(res.status).toBe(404);
  });

  it("본인 소유 대화면 메시지 전체를 createdAt asc 순서로 반환한다", async () => {
    findWithMessagesMock.mockResolvedValue({
      id: "conv-mine",
      createdBy: "user-1",
      title: "제목",
      messages: [
        {
          id: "m1",
          conversationId: "conv-mine",
          role: "user",
          text: "질문",
          toolCalls: null,
          toolCallsTruncated: false,
          actionProposalIds: null,
          createdAt: new Date("2026-07-06T00:00:00Z"),
        },
        {
          id: "m2",
          conversationId: "conv-mine",
          role: "model",
          text: "답변",
          toolCalls: [{ toolName: "get_settlement_report", args: {}, ok: true, data: {}, error: null, evidence: null }],
          toolCallsTruncated: false,
          actionProposalIds: ["ap-1"],
          createdAt: new Date("2026-07-06T00:01:00Z"),
        },
      ],
    });

    const res = await GET(new Request("http://localhost/api/assistant/conversations/conv-mine"), makeContext("conv-mine"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe("conv-mine");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("model");
    expect(body.messages[1].actionProposalIds).toEqual(["ap-1"]);
    expect(body.messages[1].toolCalls).toHaveLength(1);
  });
});

/**
 * DELETE /api/assistant/conversations/[id] — 소유 스코프 원자 삭제 (§5-1).
 * 미인증 401 · 소유자 200+deleteOwned 호출 인자 · 타인/부재는 동일한 404(존재 비노출).
 */
describe("DELETE /api/assistant/conversations/[id]", () => {
  beforeEach(() => {
    getAuthContextMock.mockReset();
    deleteOwnedMock.mockReset();
    getAuthContextMock.mockResolvedValue({ userId: "user-1", email: "a@b.com", role: "admin" });
  });

  it("인증되지 않으면 401을 반환하고 deleteOwned는 호출되지 않는다", async () => {
    getAuthContextMock.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/api/assistant/conversations/conv-1"), makeContext("conv-1"));

    expect(res.status).toBe(401);
    expect(deleteOwnedMock).not.toHaveBeenCalled();
  });

  it("본인 소유 대화면 200과 { ok: true }를 반환하고 deleteOwned를 id·userId로 호출한다", async () => {
    deleteOwnedMock.mockResolvedValue({ deleted: true });

    const res = await DELETE(new Request("http://localhost/api/assistant/conversations/conv-mine"), makeContext("conv-mine"));
    const body = await res.json();

    expect(deleteOwnedMock).toHaveBeenCalledWith("conv-mine", "user-1");
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("타인 소유 대화면 404를 반환한다(존재 비노출)", async () => {
    deleteOwnedMock.mockResolvedValue({ deleted: false });

    const res = await DELETE(new Request("http://localhost/api/assistant/conversations/conv-other"), makeContext("conv-other"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("대화를 찾을 수 없습니다.");
  });

  it("존재하지 않는 대화면 타인 소유와 동일한 404를 반환한다", async () => {
    deleteOwnedMock.mockResolvedValue({ deleted: false });

    const res = await DELETE(new Request("http://localhost/api/assistant/conversations/no-such"), makeContext("no-such"));

    expect(res.status).toBe(404);
  });
});

/**
 * PATCH /api/assistant/conversations/[id] — 대화 이름 바꾸기 (§5-2).
 * renameOwned가 { id, createdBy } 동시 조건 updateMany의 count로 판정하므로 레이스-세이프.
 * title은 트림 후 1~120자(빈 문자열·초과 400), count===0(타인 소유·부재)은 404로 통일.
 */
describe("PATCH /api/assistant/conversations/[id]", () => {
  function makePatchRequest(id: string, body: unknown) {
    return new Request(`http://localhost/api/assistant/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    getAuthContextMock.mockReset();
    renameOwnedMock.mockReset();
    getAuthContextMock.mockResolvedValue({ userId: "user-1", email: "a@b.com", role: "admin" });
  });

  it("인증되지 않으면 401을 반환하고 renameOwned는 호출되지 않는다", async () => {
    getAuthContextMock.mockResolvedValue(null);

    const res = await PATCH(makePatchRequest("conv-1", { title: "새 제목" }), makeContext("conv-1"));

    expect(res.status).toBe(401);
    expect(renameOwnedMock).not.toHaveBeenCalled();
  });

  it("본인 소유 대화면 200과 { ok: true }를 반환하고 renameOwned를 id·userId·트림된 title로 호출한다", async () => {
    renameOwnedMock.mockResolvedValue({ renamed: true });

    const res = await PATCH(makePatchRequest("conv-mine", { title: "  새 제목  " }), makeContext("conv-mine"));
    const body = await res.json();

    expect(renameOwnedMock).toHaveBeenCalledWith("conv-mine", "user-1", "새 제목");
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("타인 소유 대화면 404를 반환한다(존재 비노출)", async () => {
    renameOwnedMock.mockResolvedValue({ renamed: false });

    const res = await PATCH(makePatchRequest("conv-other", { title: "새 제목" }), makeContext("conv-other"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("대화를 찾을 수 없습니다.");
  });

  it("존재하지 않는 대화면 타인 소유와 동일한 404를 반환한다", async () => {
    renameOwnedMock.mockResolvedValue({ renamed: false });

    const res = await PATCH(makePatchRequest("no-such", { title: "새 제목" }), makeContext("no-such"));

    expect(res.status).toBe(404);
  });

  it("title이 빈 문자열(트림 후)이면 400을 반환하고 renameOwned는 호출되지 않는다", async () => {
    const res = await PATCH(makePatchRequest("conv-1", { title: "   " }), makeContext("conv-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("제목은 1~120자여야 합니다.");
    expect(renameOwnedMock).not.toHaveBeenCalled();
  });

  it("title이 120자를 초과하면 400을 반환하고 renameOwned는 호출되지 않는다", async () => {
    const res = await PATCH(makePatchRequest("conv-1", { title: "가".repeat(121) }), makeContext("conv-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("제목은 1~120자여야 합니다.");
    expect(renameOwnedMock).not.toHaveBeenCalled();
  });

  it("정확히 120자면 통과한다(경계)", async () => {
    renameOwnedMock.mockResolvedValue({ renamed: true });

    const res = await PATCH(makePatchRequest("conv-1", { title: "가".repeat(120) }), makeContext("conv-1"));

    expect(res.status).toBe(200);
    expect(renameOwnedMock).toHaveBeenCalledWith("conv-1", "user-1", "가".repeat(120));
  });

  it("body 파싱에 실패하면 400을 반환하고 renameOwned는 호출되지 않는다", async () => {
    const malformedRequest = new Request("http://localhost/api/assistant/conversations/conv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json",
    });

    const res = await PATCH(malformedRequest, makeContext("conv-1"));

    expect(res.status).toBe(400);
    expect(renameOwnedMock).not.toHaveBeenCalled();
  });
});
