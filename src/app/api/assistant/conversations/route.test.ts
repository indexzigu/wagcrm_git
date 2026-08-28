/**
 * GET /api/assistant/conversations — 본인(createdBy) 대화 목록 조회 (Phase 5 청사진 §2-2/§5).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthContextMock = vi.fn();
const listMock = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => getAuthContextMock(...args),
}));

vi.mock("@/repositories/assistantConversationRepository", () => ({
  AssistantConversationRepository: {
    list: (...args: unknown[]) => listMock(...args),
  },
}));

import { GET } from "./route";

function makeRequest(url: string): Request {
  return new Request(url);
}

describe("GET /api/assistant/conversations", () => {
  beforeEach(() => {
    getAuthContextMock.mockReset();
    listMock.mockReset();
    getAuthContextMock.mockResolvedValue({ userId: "user-1", email: "a@b.com", role: "admin" });
  });

  it("인증되지 않으면 401을 반환한다", async () => {
    getAuthContextMock.mockResolvedValue(null);

    const res = await GET(makeRequest("http://localhost/api/assistant/conversations"));

    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("본인(createdBy=userId)의 대화 목록을 반환한다", async () => {
    listMock.mockResolvedValue([
      { id: "conv-1", title: "제목1", updatedAt: new Date("2026-07-06T00:00:00Z"), messageCount: 4 },
      { id: "conv-2", title: null, updatedAt: new Date("2026-07-05T00:00:00Z"), messageCount: 2 },
    ]);

    const res = await GET(makeRequest("http://localhost/api/assistant/conversations"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("user-1", undefined);
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0].id).toBe("conv-1");
    expect(body.conversations[0].messageCount).toBe(4);
  });

  // §5-3: q 파라미터가 있으면 트림 후 list에 전달한다.
  describe("검색 (§5-3)", () => {
    it("q 파라미터가 있으면 트림 후 list(userId, q)로 전달한다", async () => {
      listMock.mockResolvedValue([]);

      const res = await GET(makeRequest("http://localhost/api/assistant/conversations?q=%20정산%20"));

      expect(res.status).toBe(200);
      expect(listMock).toHaveBeenCalledWith("user-1", "정산");
    });

    it("q가 빈 문자열이면 필터 없이 list(userId, \"\")로 전달한다(빈 q는 무필터 — repository가 처리)", async () => {
      listMock.mockResolvedValue([]);

      const res = await GET(makeRequest("http://localhost/api/assistant/conversations?q="));

      expect(res.status).toBe(200);
      expect(listMock).toHaveBeenCalledWith("user-1", "");
    });

    it("q 파라미터가 아예 없으면 list(userId, undefined)로 전달한다", async () => {
      listMock.mockResolvedValue([]);

      const res = await GET(makeRequest("http://localhost/api/assistant/conversations"));

      expect(res.status).toBe(200);
      expect(listMock).toHaveBeenCalledWith("user-1", undefined);
    });

    it("인증되지 않으면 q가 있어도 401을 반환하고 list를 호출하지 않는다", async () => {
      getAuthContextMock.mockResolvedValue(null);

      const res = await GET(makeRequest("http://localhost/api/assistant/conversations?q=정산"));

      expect(res.status).toBe(401);
      expect(listMock).not.toHaveBeenCalled();
    });
  });
});
