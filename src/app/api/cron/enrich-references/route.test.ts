import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const findManyMock = vi.fn();
const updateMock = vi.fn();
const fetchMetaMock = vi.fn();
const rehostMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    asset: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  }),
}));

// 실호출 금지(비용·외부의존) — 어댑터 모듈 전체를 모킹하고 순수 로직(reference-enrich)은 실물 사용.
// (구 reference-enrich-apify를 겨냥하던 mock이 proxy 전환 후 미갱신 → 실 네트워크로 4건 상시 실패하던 것 교정)
vi.mock("@/lib/reference-enrich-proxy", () => ({
  fetchInstagramPostMeta: (...args: unknown[]) => fetchMetaMock(...args),
  rehostReferenceThumbnail: (...args: unknown[]) => rehostMock(...args),
}));

// 2단계(캠페인 게시물 반응 지표)는 자체 단위테스트(campaign-post-engagement)로 검증 — 여기선 격리
const engagementMock = vi.fn();
vi.mock("@/lib/collectors/campaign-engagement-collector", () => ({
  syncCampaignPostEngagement: (...args: unknown[]) => engagementMock(...args),
}));

const ENGAGEMENT_STUB = {
  sellersProcessed: 0,
  sellersSkipped: 0,
  assetsUpdated: 0,
  failedCount: 0,
  deadlineReached: false,
  errors: [],
};

function createRequest(auth?: string) {
  return new Request("http://localhost:3000/api/cron/enrich-references", {
    headers: auth ? { authorization: auth } : {},
  });
}

function stubStorageConfigured() {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
}

describe("GET /api/cron/enrich-references", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    fetchMetaMock.mockReset();
    rehostMock.mockReset();
    vi.stubEnv("CRON_SECRET", "test-secret");
    engagementMock.mockReset();
    findManyMock.mockResolvedValue([]);
    updateMock.mockResolvedValue({});
    engagementMock.mockResolvedValue(ENGAGEMENT_STUB);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 401 without the CRON_SECRET bearer", async () => {
    const res = await GET(createRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 on a mismatched bearer", async () => {
    const res = await GET(createRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("degrades to a zeroed skip response when storage env is unset", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const res = await GET(createRequest("Bearer test-secret"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scanned: 0, enriched: 0, skippedUnsupported: 0, failed: 0 });
    expect(body.skipped).toContain("storage env");
    expect(findManyMock).not.toHaveBeenCalled();
    // 2단계(반응 지표)는 스토리지 무관 — 디그레이드 경로에서도 수행된다
    expect(engagementMock).toHaveBeenCalledTimes(1);
    expect(body.engagement).toEqual(ENGAGEMENT_STUB);
  });

  it("selects EXTERNAL_LINK/SNS_CREATIVE assets missing thumbnails (최근 14일, take 8)", async () => {
    stubStorageConfigured();
    const res = await GET(createRequest("Bearer test-secret"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ scanned: 0, enriched: 0, skippedUnsupported: 0, failed: 0, engagement: ENGAGEMENT_STUB });

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const callArg = findManyMock.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
    };
    expect(callArg.where).toMatchObject({
      provider: "EXTERNAL_LINK",
      section: "SNS_CREATIVE",
      thumbnailUrl: null,
      archivedAt: null,
      externalUrl: { not: null },
    });
    expect(callArg.where.createdAt).toHaveProperty("gt");
    expect(callArg.orderBy).toEqual({ createdAt: "desc" });
    expect(callArg.take).toBe(8);
  });

  it("skips unsupported hosts without touching Apify or the DB row", async () => {
    stubStorageConfigured();
    findManyMock.mockResolvedValue([
      { id: "a1", entityId: "d1", externalUrl: "https://vt.tiktok.com/ZS123/", notes: null },
    ]);
    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 0, skippedUnsupported: 1, failed: 0, engagement: ENGAGEMENT_STUB });
    expect(fetchMetaMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("enriches a youtube link via derived thumbnail (Apify 미호출)", async () => {
    stubStorageConfigured();
    findManyMock.mockResolvedValue([
      { id: "a1", entityId: "d1", externalUrl: "https://youtu.be/dQw4w9WgXcQ", notes: null },
    ]);
    rehostMock.mockResolvedValue("https://example.supabase.co/storage/v1/object/public/seller-media/deals/d1/refs/a1.webp");

    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 1, skippedUnsupported: 0, failed: 0, engagement: ENGAGEMENT_STUB });
    expect(fetchMetaMock).not.toHaveBeenCalled();
    expect(rehostMock).toHaveBeenCalledWith(
      "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "a1",
      "d1"
    );
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: {
        thumbnailUrl:
          "https://example.supabase.co/storage/v1/object/public/seller-media/deals/d1/refs/a1.webp",
      },
    });
  });

  it("enriches an instagram link and fills empty notes with the auto note", async () => {
    stubStorageConfigured();
    findManyMock.mockResolvedValue([
      { id: "a2", entityId: "d1", externalUrl: "https://www.instagram.com/reel/DEF456/", notes: null },
    ]);
    fetchMetaMock.mockResolvedValue({
      caption: "공구 오픈",
      thumbnailUrl: "https://cdn.example.com/orig.jpg",
      likes: 7,
    });
    rehostMock.mockResolvedValue("https://hosted.example.com/deals/d1/refs/a2.webp");

    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 1, enriched: 1, skippedUnsupported: 0, failed: 0, engagement: ENGAGEMENT_STUB });
    expect(fetchMetaMock).toHaveBeenCalledWith("https://www.instagram.com/reel/DEF456/");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: {
        thumbnailUrl: "https://hosted.example.com/deals/d1/refs/a2.webp",
        notes: "[자동수집] 공구 오픈 · 좋아요 7",
      },
    });
  });

  it("never overwrites existing user notes (사용자 메모 보호)", async () => {
    stubStorageConfigured();
    findManyMock.mockResolvedValue([
      {
        id: "a3",
        entityId: "d1",
        externalUrl: "https://www.instagram.com/reel/DEF456/",
        notes: "사장님이 직접 쓴 메모",
      },
    ]);
    fetchMetaMock.mockResolvedValue({
      caption: "덮어쓰면 안 되는 캡션",
      thumbnailUrl: "https://cdn.example.com/orig.jpg",
      likes: null,
    });
    rehostMock.mockResolvedValue("https://hosted.example.com/deals/d1/refs/a3.webp");

    await GET(createRequest("Bearer test-secret"));
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "a3" },
      data: { thumbnailUrl: "https://hosted.example.com/deals/d1/refs/a3.webp" },
    });
  });

  it("isolates per-item failures — 한 건 실패가 다음 건을 막지 않는다", async () => {
    stubStorageConfigured();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findManyMock.mockResolvedValue([
      { id: "bad", entityId: "d1", externalUrl: "https://www.instagram.com/reel/BAD111/", notes: null },
      { id: "good", entityId: "d1", externalUrl: "https://youtu.be/dQw4w9WgXcQ", notes: null },
    ]);
    fetchMetaMock.mockRejectedValue(new Error("Apify post run failed: 500"));
    rehostMock.mockResolvedValue("https://hosted.example.com/deals/d1/refs/good.webp");

    const res = await GET(createRequest("Bearer test-secret"));
    expect(await res.json()).toEqual({ scanned: 2, enriched: 1, skippedUnsupported: 0, failed: 1, engagement: ENGAGEMENT_STUB });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "good" },
      data: { thumbnailUrl: "https://hosted.example.com/deals/d1/refs/good.webp" },
    });
    // 실패는 삼키지 않고 로깅(P0)
    // 실패 로그만 계수 — withSystemTaskStatus의 상태기록 실패 로그(prisma mock에 systemTaskStatus 없음)는 제외
    const sweepErrors = consoleErrorSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("[enrich-references] asset"),
    );
    expect(sweepErrors).toHaveLength(1);
    expect(String(sweepErrors[0][0])).toContain("bad");
  });
});
