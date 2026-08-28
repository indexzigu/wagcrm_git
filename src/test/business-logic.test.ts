import { describe, expect, it } from "vitest";
import {
  chooseAssetProvider,
  decryptSecret,
  encryptSecret,
  SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES,
  SUPABASE_STORAGE_WARNING_BYTES,
} from "../lib/asset-storage";
import { applySlideMargin, resolveBaseMargin } from "../lib/margin";
import { seedMarginPolicy } from "../lib/mock-data";
import { buildNaverTrackingLink } from "../lib/tracking";

describe("margin policy", () => {
  it("resolves channel base margin", () => {
    expect(resolveBaseMargin(seedMarginPolicy, "OWN_MALL")).toEqual({
      totalMarginRate: 18,
      sellerMarginRate: 10,
    });
  });

  it("applies slide margin when actual sales crosses threshold", () => {
    expect(applySlideMargin(seedMarginPolicy, "OWN_MALL", 31000000)).toEqual({
      totalMarginRate: 23,
      sellerMarginRate: 12,
      netMarginRate: 11,
    });
  });
});

describe("asset storage policy", () => {
  it("keeps small working files in Supabase storage by default", () => {
    expect(
      chooseAssetProvider({
        sizeBytes: 2 * 1024 * 1024,
        currentSupabaseBytes: 0,
        googleDriveConnected: true,
      }),
    ).toBe("SUPABASE");
  });

  it("moves long-term or large files to Drive when connected", () => {
    expect(
      chooseAssetProvider({
        sizeBytes: SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES + 1,
        googleDriveConnected: true,
      }),
    ).toBe("GOOGLE_DRIVE");
    expect(
      chooseAssetProvider({
        sizeBytes: 1024,
        longTermArchive: true,
        googleDriveConnected: true,
      }),
    ).toBe("GOOGLE_DRIVE");
  });

  it("moves new uploads to Drive near the Supabase free-plan warning line", () => {
    expect(
      chooseAssetProvider({
        sizeBytes: 1024,
        currentSupabaseBytes: SUPABASE_STORAGE_WARNING_BYTES,
        googleDriveConnected: true,
      }),
    ).toBe("GOOGLE_DRIVE");
  });

  it("round-trips encrypted integration secrets", () => {
    // 이전에는 asset-storage 가 키 리터럴을 폴백으로 갖고 있어 env 없이도 통과했다
    // (그래서 설정 누락이 테스트에 드러나지 않았다). 이제는 명시 주입이 필요하다.
    const prev = process.env.ASSET_TOKEN_ENCRYPTION_KEY;
    process.env.ASSET_TOKEN_ENCRYPTION_KEY = "test-asset-token-key";
    try {
      const encrypted = encryptSecret("refresh-token");
      expect(encrypted).not.toBe("refresh-token");
      expect(decryptSecret(encrypted)).toBe("refresh-token");
    } finally {
      if (prev === undefined) delete process.env.ASSET_TOKEN_ENCRYPTION_KEY;
      else process.env.ASSET_TOKEN_ENCRYPTION_KEY = prev;
    }
  });

  it("ASSET_TOKEN_ENCRYPTION_KEY 가 없으면 약한 기본 키로 암호화하지 않고 실패한다", () => {
    const prev = process.env.ASSET_TOKEN_ENCRYPTION_KEY;
    delete process.env.ASSET_TOKEN_ENCRYPTION_KEY;
    try {
      expect(() => encryptSecret("refresh-token")).toThrow(/ASSET_TOKEN_ENCRYPTION_KEY/);
    } finally {
      if (prev !== undefined) process.env.ASSET_TOKEN_ENCRYPTION_KEY = prev;
    }
  });
});

describe("tracking links", () => {
  it("merges naver parameters with existing query params", () => {
    const link = buildNaverTrackingLink({
      baseUrl: "https://brand.example.com/item?ref=home",
      snsType: "INSTAGRAM",
      sellerId: "seller-1",
      campaignId: "campaign-1",
    });
    expect(link).toBe(
      "https://brand.example.com/item?ref=home&nt_source=INSTAGRAM&nt_medium=seller-1&nt_detail=campaign-1",
    );
  });
});
