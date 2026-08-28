import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extFromContentType,
  isRehostedUrl,
  isSellerMediaStorageConfigured,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";

const BASE = "https://proj.supabase.co";

describe("seller-media-storage 순수 헬퍼", () => {
  it("extFromContentType — content-type → 확장자", () => {
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("image/webp")).toBe("webp");
    expect(extFromContentType("image/gif")).toBe("gif");
    expect(extFromContentType("image/jpeg")).toBe("jpg");
    expect(extFromContentType("application/octet-stream")).toBe("jpg");
  });

  it("isRehostedUrl — 공용 버킷 경로만 true", () => {
    expect(isRehostedUrl(`${BASE}/storage/v1/object/public/seller-media/sellers/s1/0.jpg`)).toBe(true);
    expect(isRehostedUrl("https://scontent.cdninstagram.com/x.jpg")).toBe(false);
    expect(isRehostedUrl(null)).toBe(false);
    expect(isRehostedUrl(123)).toBe(false);
  });
});

describe("isSellerMediaStorageConfigured", () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origPub = process.env.NEXT_PUBLIC_SUPABASE_URL;

  afterEach(() => {
    process.env.SUPABASE_URL = origUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
    process.env.NEXT_PUBLIC_SUPABASE_URL = origPub;
  });

  it("URL + service role key 둘 다 있어야 true", () => {
    process.env.SUPABASE_URL = BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    expect(isSellerMediaStorageConfigured()).toBe(true);

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isSellerMediaStorageConfigured()).toBe(false);

    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(isSellerMediaStorageConfigured()).toBe(false);
  });
});

describe("uploadBytes", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("성공 경로 — 공용 버킷 object 경로로 1회 업로드", async () => {
    // 파라미터 시그니처를 명시해야 mock.calls[0] 튜플 인덱싱이 타입 안전하다
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadBytes("sellers/s1/profile.webp", new ArrayBuffer(8), "image/webp");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/storage/v1/object/seller-media/sellers/s1/profile.webp`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-upsert"]).toBe("true");
    expect(headers.Authorization).toBe("Bearer svc");
  });

  it("버킷 부재 시 — 버킷 생성 후 재시도", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/storage/v1/bucket")) return { ok: true, text: async () => "" };
      // 첫 object PUT은 Bucket not found, 재시도는 성공
      const objectCalls = calls.filter((c) => c.includes("/object/")).length;
      if (objectCalls === 1) return { ok: false, text: async () => "Bucket not found" };
      return { ok: true, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadBytes("sellers/s1/0.jpg", new ArrayBuffer(4), "image/jpeg");

    // object(실패) → bucket(생성) → object(재시도 성공)
    expect(calls.some((c) => c.includes("/storage/v1/bucket"))).toBe(true);
    expect(calls.filter((c) => c.includes("/object/")).length).toBe(2);
  });

  it("버킷 외 오류는 throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "403 forbidden" })));
    await expect(uploadBytes("sellers/s1/0.jpg", new ArrayBuffer(4), "image/jpeg")).rejects.toThrow(/업로드 실패/);
  });
});
