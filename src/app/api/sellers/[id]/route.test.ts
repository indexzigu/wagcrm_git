import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";
import { encrypt } from "@/lib/encryption";

/**
 * 저장된 주민등록번호가 현재 `ENCRYPTION_KEY` 로 열리지 않을 때, PATCH 가 저장을 마치고도
 * **응답을 만들다가** 죽지 않는지 고정한다.
 *
 * 배경(2026-08-12 실사고): 셀프호스팅 컷오버로 키가 갈리자 `PATCH /api/sellers/[id]` 가
 * 500 이 됐다. #382 는 감사 로그 생성 경로(`buildResidentNumberAuditEntry`)를 막았지만
 * **응답 직렬화용 복호화는 가드 없이 남아** 있어, 열리지 않는 값을 가진 셀러의 *다른 필드*
 * 를 고치면 DB 쓰기가 끝난 뒤 응답에서 터진다 — 고장난 값이 그 셀러의 모든 수정을 막는다.
 *
 * ⚠️ 여기서 `@/lib/encryption` 은 **모킹하지 않는다.** 키 불일치는 이 사고의 본질이라
 * 실제 파생 규칙(`padEnd(32)`)과 실제 GCM 인증 실패로 재현해야 한다.
 */

const sellerFindUniqueMock = vi.fn();
const sellerUpdateMock = vi.fn();
const recordActivityChangeMock = vi.fn();
const recordSellerFollowersSnapshotMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: {
      findUnique: (...args: unknown[]) => sellerFindUniqueMock(...args),
      update: (...args: unknown[]) => sellerUpdateMock(...args),
    },
  }),
}));

vi.mock("@/lib/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity-log")>();
  return {
    ...actual,
    recordActivityChange: (...args: unknown[]) => recordActivityChangeMock(...args),
    recordActivityDelete: vi.fn(),
  };
});

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/seller-history", () => ({
  recordSellerFollowersSnapshot: (...args: unknown[]) => recordSellerFollowersSnapshotMock(...args),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateMasterDataCaches: vi.fn(),
}));

/** 이 값들을 암호화한 구 키 — 컷오버 전 프로덕션에 있던 키를 대신한다. */
const KEY_BEFORE_CUTOVER = "key-before-cutover-0000000000000";
/** 컷오버 후 앱이 실제로 쓰는 키. 위 키로 암호화된 값은 이 키로 열리지 않는다. */
const KEY_AFTER_CUTOVER = "key-after-cutover-11111111111111";

const SELLER_ID = "seller-1";

function patchRequest(body: Record<string, unknown>): Request {
  return new Request(`http://localhost:3000/api/sellers/${SELLER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: SELLER_ID }) };
}

/** 구 키로 암호화해 둔 값 — 현재 키로는 열리지 않는다. */
function cipherFromOldKey(plain: string): string {
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY_BEFORE_CUTOVER;
  try {
    return encrypt(plain);
  } finally {
    process.env.ENCRYPTION_KEY = saved;
  }
}

describe("PATCH /api/sellers/[id] — 열리지 않는 주민등록번호가 저장을 막지 않는다", () => {
  let originalKey: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let unreadableCipher: string;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY_AFTER_CUTOVER;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;

    unreadableCipher = cipherFromOldKey("주민등록번호-평문-자리표시자");

    sellerFindUniqueMock.mockReset();
    sellerUpdateMock.mockReset();
    recordActivityChangeMock.mockReset();
    recordSellerFollowersSnapshotMock.mockReset();

    sellerFindUniqueMock.mockResolvedValue({
      id: SELLER_ID,
      name: "셀러",
      alias: null,
      snsHandle: "handle",
      residentNumber: unreadableCipher,
      availabilityNote: null,
      collaborationScore: null,
      adResponseScore: null,
      commentResponseScore: null,
      activityFrequency: null,
      currentFollowers: 0,
    });
    sellerUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: SELLER_ID,
      name: "셀러",
      alias: data.alias ?? null,
      residentNumber: unreadableCipher,
    }));

    // 라우트가 남기는 경고·로그로 테스트 출력이 더러워지지 않게 가로챈다(단언에도 쓴다).
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  it("다른 필드만 고칠 때 200 으로 응답하고 저장을 되돌리지 않는다", async () => {
    const response = await PATCH(patchRequest({ alias: "새 활동명" }), context());

    expect(response.status).toBe(200);
    expect(sellerUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("열리지 않는 값을 null 로 내보내고 암호문을 응답에 싣지 않는다", async () => {
    const response = await PATCH(patchRequest({ alias: "새 활동명" }), context());
    const body = await response.json();

    expect(body.residentNumber).toBeNull();
    expect(JSON.stringify(body)).not.toContain(unreadableCipher);
    // 조용히 넘기지는 않는다 — 실패는 경고로 남는다(값은 남기지 않는다).
    expect(warnSpy).toHaveBeenCalled();
  });

  // 과잉수정 방지선 — 위 두 건을 "항상 null 을 돌려준다"로 고치면 여기서 걸린다.
  it("현재 키로 열리는 값은 그대로 평문으로 돌려준다", async () => {
    const readable = encrypt("주민등록번호-평문-자리표시자");
    sellerUpdateMock.mockResolvedValue({
      id: SELLER_ID,
      name: "셀러",
      alias: "새 활동명",
      residentNumber: readable,
    });

    const response = await PATCH(patchRequest({ alias: "새 활동명" }), context());
    const body = await response.json();

    expect(body.residentNumber).toBe("주민등록번호-평문-자리표시자");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
