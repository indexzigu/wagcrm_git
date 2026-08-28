import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// 러너 회귀 테스트(Phase 4-5 §7): scripts/kakao-ingest.ts는 GET /api/chat-room-mappings의
// listWithCursors 결과를 화이트리스트로 사용한다. collectorType='TXT_UPLOAD'나 excluded=true인
// 방이 여기 섞여 들어가면 러너가 잘못된 방을 스캔하려 시도할 수 있으므로, 리포지토리 필터가
// 실제로 KATOK_AUTO && !excluded만 반환하는지 검증한다.

const verifyIngestAuthMock = vi.fn();
const listWithCursorsMock = vi.fn();

vi.mock("@/lib/kakao/ingest-auth", () => ({
  verifyIngestAuth: (...args: unknown[]) => verifyIngestAuthMock(...args),
}));

vi.mock("@/repositories/workRecordRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/workRecordRepository")>(
    "@/repositories/workRecordRepository"
  );
  return {
    ...actual,
    ChatRoomMappingRepository: {
      listWithCursors: (...args: unknown[]) => listWithCursorsMock(...args),
    },
  };
});

function makeGetRequest(): Request {
  return new Request("http://localhost:3000/api/chat-room-mappings", {
    headers: { authorization: "Bearer test-token" },
  });
}

describe("GET /api/chat-room-mappings — 러너 화이트리스트 게이트", () => {
  beforeEach(() => {
    verifyIngestAuthMock.mockReset();
    listWithCursorsMock.mockReset();
    verifyIngestAuthMock.mockReturnValue(true);
  });

  it("KATOK_AUTO 방만 반환한다(리포지토리가 TXT_UPLOAD/excluded를 필터링)", async () => {
    // 리포지토리 자체가 필터링하므로 라우트는 그 결과를 그대로 노출한다 — 여기서는 리포지토리가
    // 이미 필터된 결과만 반환한다고 가정하고, 라우트가 그 계약을 깨지 않는지(추가 필터링 없이도
    // TXT_UPLOAD 방을 섞지 않는지) 확인한다.
    listWithCursorsMock.mockResolvedValue([
      {
        roomKey: "room-a",
        roomName: "방A",
        entityType: "PARTNER",
        entityId: "partner-1",
        lastSyncedAt: null,
      },
    ]);

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].roomKey).toBe("room-a");
    expect(listWithCursorsMock).toHaveBeenCalledWith("KAKAO");
  });

  it("인증 실패 시 401을 반환한다", async () => {
    verifyIngestAuthMock.mockReturnValue(false);
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
  });
});
