import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// storeRawObject의 로컬 폴백 경로가 실제 워크트리에 파일을 쓰지 않도록 fs만 모킹한다.
vi.mock("node:fs/promises", () => {
  const mocked = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.from("")),
    rm: vi.fn(async () => undefined),
  };
  return { ...mocked, default: mocked };
});

import { mkdir, writeFile } from "node:fs/promises";
import { normalizeAssetStorageSegment, storeRawObject } from "./asset-storage";

// 가격표 원본은 한글 파일명이 기본값이다 — Supabase 오브젝트 키는 ASCII만 허용하므로
// basename 정규화가 이 계약을 지키는지 직접 고정한다(업로드 라우트 saveOriginalFile 소비).
describe("normalizeAssetStorageSegment", () => {
  it("한글 전용 basename은 fallback으로 대체된다", () => {
    expect(normalizeAssetStorageSegment("가격표", "pricesheet")).toBe("pricesheet");
  });

  it("한글·공백 혼합은 ASCII 안전 문자만 남긴다", () => {
    const result = normalizeAssetStorageSegment("비비랩 가격표(7월) v2", "pricesheet");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9._()-]+$/);
  });

  it("경로 순회 문자는 슬래시 없는 세그먼트로 무력화된다", () => {
    const result = normalizeAssetStorageSegment("../../etc/passwd", "pricesheet");
    expect(result).not.toContain("/");
    expect(result).not.toMatch(/^\./);
  });
});

const SUPABASE_ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
] as const;

describe("storeRawObject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("Supabase 미설정(로컬 dev)이면 .asset-storage 파일 폴백에 쓴다", async () => {
    for (const key of SUPABASE_ENV_KEYS) vi.stubEnv(key, "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const storagePath = await storeRawObject(
      "PRICE_SHEET/20260716_test.png",
      Buffer.from("png-bytes"),
      "image/png",
    );

    expect(storagePath).toBe("PRICE_SHEET/20260716_test.png");
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const writtenPath = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
    expect(writtenPath).toContain(".asset-storage");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Supabase 설정 시 버킷에 업로드하고 파일시스템에는 쓰지 않는다 (Vercel /var/task 읽기 전용)", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const storagePath = await storeRawObject(
      "PRICE_SHEET/20260716_test.png",
      Buffer.from("png-bytes"),
      "image/png",
    );

    expect(storagePath).toBe("PRICE_SHEET/20260716_test.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://example.supabase.co/storage/v1/object/");
    expect(url).toContain("/PRICE_SHEET/20260716_test.png");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
