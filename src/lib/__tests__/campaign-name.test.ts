/**
 * Unit tests for campaign-name utility.
 *
 * Tests the generateCampaignName function for correct format,
 * null handling, and truncation behavior.
 */

import { describe, it, expect } from "vitest";
import { generateCampaignName } from "../campaign-name";

describe("generateCampaignName", () => {
  it("returns formatted name with round number", () => {
    expect(generateCampaignName("글로우 앰플", "미나", 4)).toBe(
      "글로우 앰플 - 미나 4차"
    );
  });

  it("returns formatted name without round number", () => {
    expect(generateCampaignName("글로우 앰플", "미나", null)).toBe(
      "글로우 앰플 - 미나"
    );
  });

  it("returns null when dealName is null", () => {
    expect(generateCampaignName(null, "미나", 1)).toBeNull();
  });

  it("returns null when sellerName is null", () => {
    expect(generateCampaignName("글로우 앰플", null, 1)).toBeNull();
  });

  it("returns null when dealName is empty string", () => {
    expect(generateCampaignName("", "미나", 1)).toBeNull();
  });

  it("returns null when sellerName is empty string", () => {
    expect(generateCampaignName("글로우 앰플", "", 1)).toBeNull();
  });

  it("truncates at 100 characters", () => {
    const longDealName = "가".repeat(80);
    const sellerName = "나".repeat(30);
    const result = generateCampaignName(longDealName, sellerName, 1);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
  });

  it("does not truncate when name is exactly 100 characters", () => {
    // "A - B" = 5 chars base, need total 100
    const dealName = "A".repeat(48);
    const sellerName = "B".repeat(49); // "AAA...A - BBB...B" = 48 + 3 + 49 = 100
    const result = generateCampaignName(dealName, sellerName, null);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
  });

  it("handles roundNumber of 0", () => {
    expect(generateCampaignName("딜", "셀러", 0)).toBe("딜 - 셀러 0차");
  });
});
