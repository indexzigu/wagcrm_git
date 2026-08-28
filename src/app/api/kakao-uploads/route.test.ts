import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// 합성 데이터만 사용 — 실 카톡 원문은 절대 사용하지 않는다.

const requireAuthMock = vi.fn();
const findByRoomKeyMock = vi.fn();
const upsertByHashMock = vi.fn();
const chatRoomUpsertMock = vi.fn();
const touchSyncMock = vi.fn();
const attributeByRoomMock = vi.fn();
const workRecordFindManyMock = vi.fn();

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
      findByRoomKey: (...args: unknown[]) => findByRoomKeyMock(...args),
      upsert: (...args: unknown[]) => chatRoomUpsertMock(...args),
      touchSync: (...args: unknown[]) => touchSyncMock(...args),
    },
    WorkRecordRepository: {
      upsertByHash: (...args: unknown[]) => upsertByHashMock(...args),
      attributeByRoom: (...args: unknown[]) => attributeByRoomMock(...args),
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    workRecord: {
      findMany: (...args: unknown[]) => workRecordFindManyMock(...args),
    },
  }),
}));

const VARIANT_A_TXT = `테스트방 님과 카카오톡 대화
저장한 날짜 : 2026-07-05 12:00:00

--------------- 2026년 7월 1일 수요일 ---------------
[홍길동] [오전 9:00] 안녕하세요
[김철수] [오전 9:01] 네 안녕하세요
`;

function makeFile(content: string, name = "room.txt"): File {
  return new File([content], name, { type: "text/plain" });
}

function makeFormData(
  overrides: Partial<{
    file: File;
    mode: string;
    mappingEntityType: string;
    mappingEntityId: string;
    mappingCampaignId: string;
  }> = {}
): FormData {
  const fd = new FormData();
  fd.append("file", overrides.file ?? makeFile(VARIANT_A_TXT));
  fd.append("mode", overrides.mode ?? "preview");
  if (overrides.mappingEntityType) fd.append("mappingEntityType", overrides.mappingEntityType);
  if (overrides.mappingEntityId) fd.append("mappingEntityId", overrides.mappingEntityId);
  if (overrides.mappingCampaignId) fd.append("mappingCampaignId", overrides.mappingCampaignId);
  return fd;
}

// jsdom의 Request 구현이 File 본문을 포함한 real multipart 인코딩/파싱 왕복에서 멈추는
// 이슈가 관찰되어(request.formData()가 resolve되지 않음), 실제 Request 대신 formData()
// 메서드만 노출하는 최소 스텁을 사용한다. 라우트는 request.formData()의 반환값(FormData
// 인스턴스)만 사용하므로 실제 동작에는 차이가 없다 — File.text()/File.size 등은 real File
// 인스턴스를 그대로 쓰므로 정상 동작한다.
function makeRequest(formData: FormData): Request {
  return { formData: async () => formData } as unknown as Request;
}

describe("POST /api/kakao-uploads", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    findByRoomKeyMock.mockReset();
    upsertByHashMock.mockReset();
    chatRoomUpsertMock.mockReset();
    touchSyncMock.mockReset();
    attributeByRoomMock.mockReset();
    workRecordFindManyMock.mockReset();

    requireAuthMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "user-1", email: "test@wag-crm.local", role: "admin" },
    });
    findByRoomKeyMock.mockResolvedValue(null);
    upsertByHashMock.mockResolvedValue({});
    chatRoomUpsertMock.mockResolvedValue({});
    touchSyncMock.mockResolvedValue({});
    attributeByRoomMock.mockResolvedValue({ count: 0 });
    workRecordFindManyMock.mockResolvedValue([]);
  });

  it("세션이 없으면 401을 반환한다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const response = await POST(makeRequest(makeFormData()));
    expect(response.status).toBe(401);
  });

  it(".txt가 아닌 파일은 400을 반환한다", async () => {
    const fd = makeFormData({ file: makeFile(VARIANT_A_TXT, "room.pdf") });
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(400);
  });

  it("4MB 초과 파일은 400을 반환한다", async () => {
    const bigContent = "a".repeat(4 * 1024 * 1024 + 1);
    const fd = makeFormData({ file: makeFile(bigContent) });
    const response = await POST(makeRequest(fd));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("4MB");
  });

  it("preview 모드는 DB 쓰기 없이 통계만 반환한다", async () => {
    const response = await POST(makeRequest(makeFormData({ mode: "preview" })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roomName).toBe("테스트방");
    expect(body.messageCount).toBe(2);
    expect(body.chunkCount).toBeGreaterThan(0);
    expect(upsertByHashMock).not.toHaveBeenCalled();
    expect(chatRoomUpsertMock).not.toHaveBeenCalled();
  });

  it("preview 응답에 원문 텍스트가 포함되지 않는다", async () => {
    const response = await POST(makeRequest(makeFormData({ mode: "preview" })));
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("안녕하세요");
  });

  it("KATOK_AUTO 방이면 409를 반환한다(이중 수집 차단)", async () => {
    findByRoomKeyMock.mockResolvedValue({
      collectorType: "KATOK_AUTO",
      entityType: null,
      entityId: null,
      campaignId: null,
      roomType: null,
      excluded: false,
    });

    const response = await POST(makeRequest(makeFormData({ mode: "preview" })));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toContain("사장 Mac 자동 수집 담당 방");
  });

  it("excluded 방이면 409를 반환한다", async () => {
    findByRoomKeyMock.mockResolvedValue({
      collectorType: "TXT_UPLOAD",
      entityType: null,
      entityId: null,
      campaignId: null,
      roomType: null,
      excluded: true,
    });

    const response = await POST(makeRequest(makeFormData({ mode: "preview" })));
    expect(response.status).toBe(409);
  });

  it("commit 모드는 ingestedBy에 세션 userId를 기록한다", async () => {
    const response = await POST(makeRequest(makeFormData({ mode: "commit" })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(upsertByHashMock).toHaveBeenCalled();
    for (const call of upsertByHashMock.mock.calls) {
      expect(call[0].ingestedBy).toBe("user-1");
      expect(call[0].source).toBe("KAKAO_TXT");
    }
    expect(body.upserted).toBeGreaterThan(0);
  });

  it("commit 모드는 방 매핑을 TXT_UPLOAD로 upsert한다", async () => {
    await POST(makeRequest(makeFormData({ mode: "commit" })));
    expect(chatRoomUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "KAKAO_TXT", collectorType: "TXT_UPLOAD" })
    );
  });

  it("이미 존재하는 sourceHash는 skipped로 카운트된다", async () => {
    // ingest-mapper가 계산할 sourceHash를 미리 알 수 없으므로, findMany가 임의의 해시 1개를
    // "이미 존재"로 반환하도록 목킹해 최소 1건 이상 skipped가 되는지 확인한다.
    workRecordFindManyMock.mockImplementation(async ({ where }: { where: { sourceHash: { in: string[] } } }) => {
      const hashes = where.sourceHash.in;
      return hashes.length > 0 ? [{ sourceHash: hashes[0] }] : [];
    });

    const response = await POST(makeRequest(makeFormData({ mode: "commit" })));
    const body = await response.json();
    expect(body.skipped).toBeGreaterThanOrEqual(1);
  });

  it("m6: upsertByHash 실패 시 내부 에러 메시지를 노출하지 않고 일반화된 사유를 담는다", async () => {
    upsertByHashMock.mockRejectedValue(
      new Error("Invalid `prisma.workRecord.upsert()` invocation: Server has closed the connection.")
    );

    const response = await POST(makeRequest(makeFormData({ mode: "commit" })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.errors).toBeDefined();
    for (const err of body.errors) {
      expect(err.reason).not.toContain("prisma");
      expect(err.reason).not.toContain("Server has closed the connection");
    }
  });

  it("m9: mappingEntityType이 화이트리스트(PARTNER/SELLER) 밖이면 무시된다", async () => {
    const response = await POST(
      makeRequest(
        makeFormData({ mode: "commit", mappingEntityType: "HACKED_TYPE", mappingEntityId: "x" })
      )
    );
    expect(response.status).toBe(200);
    for (const call of upsertByHashMock.mock.calls) {
      expect(call[0].entityType).toBeNull();
      expect(call[0].attributedBy).toBeNull();
    }
    expect(attributeByRoomMock).not.toHaveBeenCalled();
  });

  it("m9: mappingEntityType이 PARTNER/SELLER면 정상 반영된다", async () => {
    const response = await POST(
      makeRequest(
        makeFormData({ mode: "commit", mappingEntityType: "SELLER", mappingEntityId: "seller-1" })
      )
    );
    expect(response.status).toBe(200);
    for (const call of upsertByHashMock.mock.calls) {
      expect(call[0].entityType).toBe("SELLER");
      expect(call[0].entityId).toBe("seller-1");
      expect(call[0].attributedBy).toBe("AUTO");
    }
  });

  it("m9: roomType은 항상 DIRECT/GROUP/OPEN 화이트리스트 내 값만 응답에 담긴다", async () => {
    const response = await POST(makeRequest(makeFormData({ mode: "preview" })));
    const body = await response.json();
    expect(["DIRECT", "GROUP", "OPEN"]).toContain(body.roomType);
  });
});
