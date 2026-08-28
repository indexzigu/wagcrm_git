import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "./route";

const requireAuthMock = vi.fn();
const listAllMock = vi.fn();
const listUnmappedRoomsMock = vi.fn();
const chatRoomUpsertMock = vi.fn();
const attributeByRoomMock = vi.fn();
const partnerFindManyMock = vi.fn();
const sellerFindManyMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/repositories/workRecordRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/workRecordRepository")>(
    "@/repositories/workRecordRepository"
  );
  return {
    ...actual,
    ChatRoomMappingRepository: {
      listAll: (...args: unknown[]) => listAllMock(...args),
      listUnmappedRooms: (...args: unknown[]) => listUnmappedRoomsMock(...args),
      upsert: (...args: unknown[]) => chatRoomUpsertMock(...args),
    },
    WorkRecordRepository: {
      attributeByRoom: (...args: unknown[]) => attributeByRoomMock(...args),
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    partner: { findMany: (...args: unknown[]) => partnerFindManyMock(...args) },
    seller: { findMany: (...args: unknown[]) => sellerFindManyMock(...args) },
  }),
}));

function jsonRequest(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

describe("GET /api/chat-room-mappings/manage", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    listAllMock.mockReset();
    listUnmappedRoomsMock.mockReset();
    partnerFindManyMock.mockReset();
    sellerFindManyMock.mockReset();

    requireAuthMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "user-1", email: "a@b.com", role: "admin" },
    });
    listAllMock.mockResolvedValue([]);
    listUnmappedRoomsMock.mockResolvedValue([]);
    partnerFindManyMock.mockResolvedValue([]);
    sellerFindManyMock.mockResolvedValue([]);
  });

  it("세션이 없으면 401을 반환한다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("매핑된 방과 미매핑 방을 병합해 반환한다", async () => {
    listAllMock.mockResolvedValue([
      {
        id: "m1",
        source: "KAKAO",
        roomKey: "room-a",
        roomName: "방A",
        roomType: "GROUP",
        collectorType: "KATOK_AUTO",
        excluded: false,
        entityType: "PARTNER",
        entityId: "partner-1",
        campaignId: null,
        lastSyncedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
    listUnmappedRoomsMock.mockImplementation(async (source: string) =>
      source === "KAKAO_TXT"
        ? [{ roomKey: "TXT:xyz", lastSeenAt: new Date("2026-07-02T00:00:00Z"), messageCount: 5 }]
        : []
    );
    partnerFindManyMock.mockResolvedValue([{ id: "partner-1", name: "테스트 파트너" }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rooms).toHaveLength(2);
    const mappedRoom = body.rooms.find((r: { roomKey: string }) => r.roomKey === "room-a");
    expect(mappedRoom.entityName).toBe("테스트 파트너");
    expect(mappedRoom.mapped).toBe(true);
    const unmappedRoom = body.rooms.find((r: { roomKey: string }) => r.roomKey === "TXT:xyz");
    expect(unmappedRoom.mapped).toBe(false);
    expect(unmappedRoom.messageCount).toBe(5);
  });
});

describe("PATCH /api/chat-room-mappings/manage", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    chatRoomUpsertMock.mockReset();
    attributeByRoomMock.mockReset();

    requireAuthMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "user-1", email: "a@b.com", role: "admin" },
    });
    chatRoomUpsertMock.mockResolvedValue({ id: "m1" });
    attributeByRoomMock.mockResolvedValue({ count: 2 });
  });

  it("세션이 없으면 401을 반환한다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const response = await PATCH(jsonRequest({ source: "KAKAO", roomKey: "room-a" }));
    expect(response.status).toBe(401);
  });

  it("잘못된 payload는 400을 반환한다", async () => {
    const response = await PATCH(jsonRequest({ roomKey: "room-a" }));
    expect(response.status).toBe(400);
  });

  it("엔티티 매핑을 지정하면 attributeByRoom을 호출한다(소급 귀속)", async () => {
    const response = await PATCH(
      jsonRequest({
        source: "KAKAO_TXT",
        roomKey: "TXT:xyz",
        entityType: "SELLER",
        entityId: "seller-1",
      })
    );
    expect(response.status).toBe(200);
    expect(attributeByRoomMock).toHaveBeenCalledWith(
      "TXT:xyz",
      expect.objectContaining({ entityType: "SELLER", entityId: "seller-1", source: "KAKAO_TXT" })
    );
  });

  it("담당 전환(collectorType)만 지정하면 attributeByRoom을 호출하지 않는다", async () => {
    await PATCH(
      jsonRequest({
        source: "KAKAO_TXT",
        roomKey: "TXT:xyz",
        collectorType: "EXCLUDED",
      })
    );
    expect(attributeByRoomMock).not.toHaveBeenCalled();
    expect(chatRoomUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ collectorType: "EXCLUDED" })
    );
  });

  it("m5: source가 KAKAO/KAKAO_TXT가 아니면 400을 반환한다", async () => {
    const response = await PATCH(
      jsonRequest({ source: "SOME_OTHER_SOURCE", roomKey: "room-a" })
    );
    expect(response.status).toBe(400);
    expect(chatRoomUpsertMock).not.toHaveBeenCalled();
  });

  it("m6: 리포지토리 오류 시 내부 에러 메시지를 노출하지 않고 일반화된 메시지를 반환한다", async () => {
    chatRoomUpsertMock.mockRejectedValue(
      new Error("Invalid `prisma.chatRoomMapping.upsert()` invocation: connection reset by peer at 10.0.0.5")
    );

    const response = await PATCH(jsonRequest({ source: "KAKAO_TXT", roomKey: "TXT:xyz" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain("prisma");
    expect(body.error).not.toContain("10.0.0.5");
    expect(body.error).toBe("방 매핑 저장 중 오류가 발생했습니다.");
  });
});
