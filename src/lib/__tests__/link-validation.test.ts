import { describe, it, expect } from "vitest";
import {
  linkDealRequestSchema,
  linkCampaignRequestSchema,
} from "../validations/link";

describe("linkDealRequestSchema", () => {
  it("accepts a valid partnerId", () => {
    const result = linkDealRequestSchema.safeParse({ partnerId: "clxyz123" });
    expect(result.success).toBe(true);
  });

  it("rejects empty partnerId", () => {
    const result = linkDealRequestSchema.safeParse({ partnerId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing partnerId", () => {
    const result = linkDealRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null partnerId", () => {
    const result = linkDealRequestSchema.safeParse({ partnerId: null });
    expect(result.success).toBe(false);
  });
});

describe("linkCampaignRequestSchema", () => {
  it("accepts a valid dealId", () => {
    const result = linkCampaignRequestSchema.safeParse({ dealId: "clxyz456" });
    expect(result.success).toBe(true);
  });

  it("rejects empty dealId", () => {
    const result = linkCampaignRequestSchema.safeParse({ dealId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing dealId", () => {
    const result = linkCampaignRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null dealId", () => {
    const result = linkCampaignRequestSchema.safeParse({ dealId: null });
    expect(result.success).toBe(false);
  });
});
