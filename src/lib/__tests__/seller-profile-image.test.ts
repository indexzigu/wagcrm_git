import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BUCKET_MARKER = "/storage/v1/object/public/seller-media/";
const SUPA_BASE = "https://proj.supabase.co/storage/v1/object/public/seller-media";

// 공용 Supabase 스토리지 어댑터를 목킹 — 프로필 미러링이 이 백엔드를 쓴다.
const uploadBytesMock = vi.fn();
let storageConfigured = true;
vi.mock("@/lib/seller-analysis/seller-media-storage", () => ({
  uploadBytes: (...args: unknown[]) => uploadBytesMock(...args),
  publicMediaUrl: (path: string) => `${SUPA_BASE}/${path}`,
  isRehostedUrl: (url: unknown) => typeof url === "string" && url.includes(BUCKET_MARKER),
  isSellerMediaStorageConfigured: () => storageConfigured,
  extFromContentType: (ct: string) =>
    ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("gif") ? "gif" : "jpg",
}));

// sharp 체이닝 API 목킹: resize/rotate/webp는 체인 반환, toBuffer가 최적화 결과.
const toBufferMock = vi.fn(async () => Buffer.from("optimized-webp"));
const sharpChain = {
  rotate: vi.fn(() => sharpChain),
  resize: vi.fn(() => sharpChain),
  webp: vi.fn(() => sharpChain),
  toBuffer: toBufferMock,
};
const sharpFactory = vi.fn(() => sharpChain);
vi.mock("sharp", () => ({ default: () => sharpFactory() }));

import {
  isMirroredProfileImage,
  mirrorSellerProfileImage,
  probeSellerProfileImage,
} from "@/lib/seller-profile-image";

const EPHEMERAL =
  "https://scontent-abc.cdninstagram.com/v/t51/profile.jpg?_nc_ohc=xyz&oe=66ABCDEF";
const MIRRORED = `${SUPA_BASE}/sellers/s1/profile.webp`;

describe("isMirroredProfileImage", () => {
  it("공용 버킷 URL은 true, 인스타 CDN URL은 false", () => {
    expect(isMirroredProfileImage(MIRRORED)).toBe(true);
    expect(isMirroredProfileImage(EPHEMERAL)).toBe(false);
    expect(isMirroredProfileImage(null)).toBe(false);
    expect(isMirroredProfileImage(undefined)).toBe(false);
  });
});

describe("mirrorSellerProfileImage", () => {
  beforeEach(() => {
    uploadBytesMock.mockReset();
    uploadBytesMock.mockResolvedValue(undefined);
    sharpFactory.mockClear();
    sharpChain.rotate.mockClear();
    sharpChain.resize.mockClear();
    sharpChain.webp.mockClear();
    toBufferMock.mockReset();
    toBufferMock.mockResolvedValue(Buffer.from("optimized-webp"));
    storageConfigured = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("undefined 시그널은 그대로 통과한다(필드 미변경 보존)", async () => {
    expect(await mirrorSellerProfileImage("s1", undefined)).toBeUndefined();
    expect(uploadBytesMock).not.toHaveBeenCalled();
  });

  it("null/빈 문자열은 그대로 반환한다", async () => {
    expect(await mirrorSellerProfileImage("s1", null)).toBeNull();
    expect(await mirrorSellerProfileImage("s1", "")).toBe("");
    expect(uploadBytesMock).not.toHaveBeenCalled();
  });

  it("이미 미러링된 공용 버킷 URL은 재업로드하지 않는다(멱등)", async () => {
    expect(await mirrorSellerProfileImage("s1", MIRRORED)).toBe(MIRRORED);
    expect(uploadBytesMock).not.toHaveBeenCalled();
  });

  it("스토리지 미설정이면 원본을 그대로 유지한다(디그레이드)", async () => {
    storageConfigured = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await mirrorSellerProfileImage("s1", EPHEMERAL)).toBe(EPHEMERAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("외부 이미지를 256px WebP로 최적화해 공용 버킷에 올리고 안정 URL을 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const result = await mirrorSellerProfileImage("s1", EPHEMERAL);

    // 원본이 png여도 webp로 재인코딩·256px 리사이즈된다
    expect(sharpChain.resize).toHaveBeenCalledWith(256, 256, {
      fit: "cover",
      withoutEnlargement: true,
    });
    expect(sharpChain.webp).toHaveBeenCalled();

    expect(uploadBytesMock).toHaveBeenCalledTimes(1);
    const [path, data, contentType] = uploadBytesMock.mock.calls[0];
    expect(path).toBe("sellers/s1/profile.webp");
    expect(Buffer.from(data as ArrayBuffer).toString()).toBe("optimized-webp");
    expect(contentType).toBe("image/webp");
    expect(result).toBe(MIRRORED);
  });

  it("최적화(sharp)가 실패하면 원본 바이트·원본 타입으로 폴백 업로드한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => new TextEncoder().encode("rawbytes").buffer,
      })),
    );
    toBufferMock.mockRejectedValue(new Error("unsupported image"));

    const result = await mirrorSellerProfileImage("s1", EPHEMERAL);

    const [path, data, contentType] = uploadBytesMock.mock.calls[0];
    expect(path).toBe("sellers/s1/profile.jpg");
    expect(Buffer.from(data as ArrayBuffer).toString()).toBe("rawbytes");
    expect(contentType).toBe("image/jpeg");
    expect(result).toBe(`${SUPA_BASE}/sellers/s1/profile.jpg`);
  });

  it("다운로드가 실패하면 원본 URL을 유지한다(스냅샷 전체를 막지 않음)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, headers: new Headers() })),
    );
    expect(await mirrorSellerProfileImage("s1", EPHEMERAL)).toBe(EPHEMERAL);
    expect(uploadBytesMock).not.toHaveBeenCalled();
  });

  it("업로드 예외가 나도 원본 URL을 유지한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );
    uploadBytesMock.mockRejectedValue(new Error("storage down"));
    expect(await mirrorSellerProfileImage("s1", EPHEMERAL)).toBe(EPHEMERAL);
  });
});

describe("probeSellerProfileImage", () => {
  beforeEach(() => {
    uploadBytesMock.mockReset();
    sharpFactory.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 이 스크립트의 예행(dry-run)이 서는 자리 — 판정만 하고 프로덕션 버킷에 파일을
  // 만들지 않는다는 것이 이 함수의 존재 이유다.
  it("살아있는 이미지는 mirrorable=true, 업로드·최적화는 하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 206,
        headers: new Headers({ "content-type": "image/jpeg" }),
      })),
    );

    const probe = await probeSellerProfileImage(EPHEMERAL);

    expect(probe).toEqual({ mirrorable: true, contentType: "image/jpeg" });
    expect(uploadBytesMock).not.toHaveBeenCalled();
    expect(sharpFactory).not.toHaveBeenCalled();
  });

  it("미러링 경로와 같은 UA를 보내고 본문은 1바이트만 요청한다", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 206,
      headers: new Headers({ "content-type": "image/webp" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await probeSellerProfileImage(EPHEMERAL);

    const headers = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(headers.Range).toBe("bytes=0-0");
  });

  it("만료된 원본(403)은 mirrorable=false와 사유를 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, headers: new Headers() })),
    );

    expect(await probeSellerProfileImage(EPHEMERAL)).toEqual({
      mirrorable: false,
      reason: "다운로드 실패 status=403",
    });
  });

  it("이미지가 아닌 응답은 mirrorable=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
      })),
    );

    const probe = await probeSellerProfileImage(EPHEMERAL);
    expect(probe.mirrorable).toBe(false);
  });

  it("네트워크 예외를 삼키지 않고 사유로 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );

    expect(await probeSellerProfileImage(EPHEMERAL)).toEqual({
      mirrorable: false,
      reason: "getaddrinfo ENOTFOUND",
    });
  });

  it("Range를 무시하고 본문을 보내는 CDN에는 본문을 취소한다", async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: { cancel },
      })),
    );

    await probeSellerProfileImage(EPHEMERAL);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
