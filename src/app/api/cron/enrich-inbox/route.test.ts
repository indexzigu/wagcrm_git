import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const findManyMock = vi.fn();
const updateMock = vi.fn();
const taskStatusUpsertMock = vi.fn();
const taskLogCreateMock = vi.fn();
const fetchProfileMock = vi.fn();
const fetchPostMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    referenceInboxItem: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
    systemTaskStatus: {
      upsert: (...args: unknown[]) => taskStatusUpsertMock(...args),
    },
    systemTaskLog: {
      create: (...args: unknown[]) => taskLogCreateMock(...args),
    },
  }),
}));

// 실호출 금지(비용·외부의존) — 어댑터만 모킹하고 순수 분류 로직(reference-enrich·reference-kind)은 실물 사용.
vi.mock("@/lib/reference-enrich-proxy", () => ({
  fetchInstagramProfileMeta: (...args: unknown[]) => fetchProfileMock(...args),
  fetchInstagramPostMeta: (...args: unknown[]) => fetchPostMock(...args),
}));

function createRequest(auth?: string) {
  return new Request("http://localhost:3000/api/cron/enrich-inbox", {
    headers: auth ? { authorization: auth } : {},
  });
}

function item(overrides: Partial<{ id: string; normalizedUrl: string }>) {
  return { id: "item-1", createdAt: new Date(), ...overrides };
}

describe("GET /api/cron/enrich-inbox", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    taskStatusUpsertMock.mockReset();
    taskLogCreateMock.mockReset();
    fetchProfileMock.mockReset();
    fetchPostMock.mockReset();
    vi.stubEnv("CRON_SECRET", "test-secret");
    findManyMock.mockResolvedValue([]);
    updateMock.mockResolvedValue({});
    taskStatusUpsertMock.mockResolvedValue({});
    taskLogCreateMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 401 without the CRON_SECRET bearer", async () => {
    const res = await GET(createRequest());
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 401 on a mismatched bearer", async () => {
    const res = await GET(createRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("selects PENDING items missing a thumbnail (최신순, take 8)", async () => {
    await GET(createRequest("Bearer test-secret"));
    expect(findManyMock).toHaveBeenCalledWith({
      where: { status: "PENDING", thumbnailUrl: null },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
  });

  it("records SUCCESS when nothing failed (빈 배치)", async () => {
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 0, enriched: 0, skippedUnsupported: 0, failed: 0 });
    expect(taskStatusUpsertMock).toHaveBeenCalledTimes(1);
    const call = taskStatusUpsertMock.mock.calls[0][0];
    expect(call.update.status).toBe("SUCCESS");
    expect(call.update.lastErrorMessage).toBeNull();
    expect(taskLogCreateMock.mock.calls[0][0].data.status).toBe("SUCCESS");
  });

  it("skips an unsupported host without touching Prisma or the fetch adapters", async () => {
    findManyMock.mockResolvedValue([item({ normalizedUrl: "https://blog.naver.com/x/1" })]);
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(fetchProfileMock).not.toHaveBeenCalled();
    expect(fetchPostMock).not.toHaveBeenCalled();
  });

  it("enriches a youtube link via derived thumbnail", async () => {
    findManyMock.mockResolvedValue([item({ normalizedUrl: "https://youtu.be/dQw4w9WgXcQ" })]);
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 1, skippedUnsupported: 0, failed: 0 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
    });
  });

  it("skips a youtube channel/playlist link that has no derivable video id", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.youtube.com/channel/UCabc123" }),
    ]);
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("enriches an instagram post via embed meta", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/p/DEF456/" }),
    ]);
    fetchPostMock.mockResolvedValue({
      caption: "공구 오픈",
      thumbnailUrl: "https://cdn.example.com/thumb.jpg",
      videoUrl: null,
      likes: null,
    });
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 1, skippedUnsupported: 0, failed: 0 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { thumbnailUrl: "https://cdn.example.com/thumb.jpg", videoUrl: null },
    });
  });

  it("enriches an instagram profile via RapidAPI userinfo", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/some_seller/" }),
    ]);
    fetchProfileMock.mockResolvedValue({
      username: "some_seller",
      fullName: "판매자",
      bio: "안녕하세요",
      followerCount: 1000,
      postCount: 42,
      profilePicUrl: "https://cdn.example.com/profile.jpg",
    });
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 1, skippedUnsupported: 0, failed: 0 });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: {
        thumbnailUrl: "https://cdn.example.com/profile.jpg",
        igUsername: "some_seller",
        igProfilePicUrl: "https://cdn.example.com/profile.jpg",
        igFullName: "판매자",
        igBio: "안녕하세요",
        igFollowerCount: 1000,
        igPostCount: 42,
      },
    });
  });

  // 회귀: 계정이 삭제·비공개라 RapidAPI가 username을 못 돌려주는 경우 — 재시도해도
  // 영원히 같은 결과라 실패로 세면 이 배치가 그 항목 때문에 매일 ERROR로 고정된다.
  it("REGRESSION: a permanently-gone instagram account (no username) is skipped, not failed — job stays SUCCESS", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/deleted_account/" }),
    ]);
    fetchProfileMock.mockResolvedValue({
      username: null,
      fullName: null,
      bio: null,
      followerCount: null,
      postCount: null,
      profilePicUrl: null,
    });
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    const statusCall = taskStatusUpsertMock.mock.calls[0][0];
    expect(statusCall.update.status).toBe("SUCCESS");
    expect(statusCall.update.lastErrorMessage).toBeNull();
  });

  // 회귀: 계정은 존재하지만(username O) 프로필 사진이 없는 경우도 같은 영구 조건이다.
  it("REGRESSION: an instagram account without a profile picture is skipped, not failed", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/no_photo_account/" }),
    ]);
    fetchProfileMock.mockResolvedValue({
      username: "no_photo_account",
      fullName: null,
      bio: null,
      followerCount: null,
      postCount: null,
      profilePicUrl: null,
    });
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // 회귀: 게시물이 삭제·비공개라 embed 응답에 썸네일이 없는 경우 — 위와 같은 이유로 무시 처리.
  it("REGRESSION: a permanently-gone instagram post (no thumbnail in embed) is skipped, not failed — job stays SUCCESS", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/p/GONE123/" }),
    ]);
    fetchPostMock.mockResolvedValue({ caption: null, thumbnailUrl: null, videoUrl: null, likes: null });
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    const statusCall = taskStatusUpsertMock.mock.calls[0][0];
    expect(statusCall.update.status).toBe("SUCCESS");
  });

  // 대조군: 진짜 장애(HTTP 레벨 실패 등)는 여전히 failed로 세고 ERROR로 표면화해야 한다 —
  // 위 회귀 수정이 실질 장애 신호까지 함께 죽이지 않았는지 확인.
  it("still counts a genuine transient error (thrown exception) as failed and flips the job to ERROR", async () => {
    findManyMock.mockResolvedValue([
      item({ normalizedUrl: "https://www.instagram.com/rate_limited_account/" }),
    ]);
    fetchProfileMock.mockRejectedValue(new Error("RapidAPI /userinfo failed: 429"));
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 0, failed: 1 });
    const statusCall = taskStatusUpsertMock.mock.calls[0][0];
    expect(statusCall.update.status).toBe("ERROR");
    expect(statusCall.update.lastErrorMessage).toBe("일부 썸네일 수집이 실패했습니다.");
  });

  it("isolates per-item failures — 한 건 실패가 다음 건을 막지 않는다", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findManyMock.mockResolvedValue([
      item({ id: "bad", normalizedUrl: "https://www.instagram.com/broken/" }),
      item({ id: "good", normalizedUrl: "https://youtu.be/dQw4w9WgXcQ" }),
    ]);
    fetchProfileMock.mockRejectedValue(new Error("RapidAPI /userinfo failed: 500"));

    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 2, enriched: 1, skippedUnsupported: 0, failed: 1 });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "good" },
      data: { thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
    });
    const sweepErrors = consoleErrorSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("[enrich-inbox] item"),
    );
    expect(sweepErrors).toHaveLength(1);
    expect(String(sweepErrors[0][0])).toContain("bad");
  });
});
