import { describe, it, expect } from "vitest";
import {
  validateBusinessNumber,
  validateChannelUrl,
  validatePartnerCreation,
  validateSellerCreation,
} from "./partner-seller";
import { PARTNER_TYPES } from "./partner";

describe("validateBusinessNumber", () => {
  it("accepts empty string (optional field)", () => {
    const result = validateBusinessNumber("");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("accepts exactly 10 digits", () => {
    const result = validateBusinessNumber("1234567890");
    expect(result.valid).toBe(true);
  });

  it("rejects fewer than 10 digits", () => {
    const result = validateBusinessNumber("123456789");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects more than 10 digits", () => {
    const result = validateBusinessNumber("12345678901");
    expect(result.valid).toBe(false);
  });

  it("rejects non-digit characters", () => {
    const result = validateBusinessNumber("123456789a");
    expect(result.valid).toBe(false);
  });

  it("rejects string with spaces", () => {
    const result = validateBusinessNumber("123 456 78");
    expect(result.valid).toBe(false);
  });

  it("rejects string with dashes", () => {
    const result = validateBusinessNumber("123-456-78");
    expect(result.valid).toBe(false);
  });
});

describe("validateChannelUrl", () => {
  it("accepts http:// URL", () => {
    const result = validateChannelUrl("http://example.com");
    expect(result.valid).toBe(true);
  });

  it("accepts https:// URL", () => {
    const result = validateChannelUrl("https://instagram.com/user");
    expect(result.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const result = validateChannelUrl("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects URL without protocol", () => {
    const result = validateChannelUrl("instagram.com/user");
    expect(result.valid).toBe(false);
  });

  it("rejects ftp:// URL", () => {
    const result = validateChannelUrl("ftp://files.example.com");
    expect(result.valid).toBe(false);
  });

  it("rejects random text", () => {
    const result = validateChannelUrl("not a url at all");
    expect(result.valid).toBe(false);
  });
});

describe("validatePartnerCreation", () => {
  it("accepts valid name and type", () => {
    const result = validatePartnerCreation({ name: "테스트 브랜드", type: "BRAND" });
    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it("accepts all valid types", () => {
    for (const type of PARTNER_TYPES) {
      const result = validatePartnerCreation({ name: "테스트", type });
      expect(result.valid).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = validatePartnerCreation({ name: "", type: "BRAND" });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it("rejects whitespace-only name", () => {
    const result = validatePartnerCreation({ name: "   ", type: "BRAND" });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it("rejects name over 50 characters", () => {
    const longName = "가".repeat(51);
    const result = validatePartnerCreation({ name: longName, type: "BRAND" });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it("accepts name exactly 50 characters", () => {
    const name = "가".repeat(50);
    const result = validatePartnerCreation({ name, type: "VENDOR" });
    expect(result.valid).toBe(true);
  });

  it("rejects missing type", () => {
    const result = validatePartnerCreation({ name: "테스트", type: "" });
    expect(result.valid).toBe(false);
    expect(result.errors.type).toBeDefined();
  });

  it("rejects invalid type", () => {
    const result = validatePartnerCreation({ name: "테스트", type: "INVALID" });
    expect(result.valid).toBe(false);
    expect(result.errors.type).toBeDefined();
  });

  it("reports both errors when both fields invalid", () => {
    const result = validatePartnerCreation({ name: "", type: "" });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
    expect(result.errors.type).toBeDefined();
  });
});

describe("validateSellerCreation", () => {
  it("accepts Combination A: valid channel URL", () => {
    const result = validateSellerCreation({
      channelUrl: "https://instagram.com/user",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts Combination A with http://", () => {
    const result = validateSellerCreation({
      channelUrl: "http://youtube.com/channel",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts Combination B: name + snsType + snsHandle", () => {
    const result = validateSellerCreation({
      name: "인플루언서",
      snsType: "INSTAGRAM",
      snsHandle: "@user",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts when both combinations are satisfied", () => {
    const result = validateSellerCreation({
      channelUrl: "https://instagram.com/user",
      name: "인플루언서",
      snsType: "INSTAGRAM",
      snsHandle: "@user",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects when neither combination is satisfied", () => {
    const result = validateSellerCreation({});
    expect(result.valid).toBe(false);
  });

  it("rejects invalid URL without Combination B", () => {
    const result = validateSellerCreation({
      channelUrl: "not-a-url",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.channelUrl).toBeDefined();
  });

  it("rejects Combination B with missing snsType", () => {
    const result = validateSellerCreation({
      name: "인플루언서",
      snsHandle: "@user",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.snsType).toBeDefined();
  });

  it("rejects Combination B with invalid snsType", () => {
    const result = validateSellerCreation({
      name: "인플루언서",
      snsType: "TIKTOK",
      snsHandle: "@user",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects Combination B with missing name", () => {
    const result = validateSellerCreation({
      snsType: "YOUTUBE",
      snsHandle: "channel",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it("rejects Combination B with missing snsHandle", () => {
    const result = validateSellerCreation({
      name: "인플루언서",
      snsType: "INSTAGRAM",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.snsHandle).toBeDefined();
  });

  it("accepts YOUTUBE as valid snsType in Combination B", () => {
    const result = validateSellerCreation({
      name: "유튜버",
      snsType: "YOUTUBE",
      snsHandle: "channel_name",
    });
    expect(result.valid).toBe(true);
  });
});
