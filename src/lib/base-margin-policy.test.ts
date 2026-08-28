import { describe, expect, it } from "vitest";
import { parseBaseMarginPolicy } from "./base-margin-policy";
import { seedMarginPolicy } from "./mock-data";

describe("parseBaseMarginPolicy", () => {
  it("returns parsed JSON policies", () => {
    const result = parseBaseMarginPolicy(JSON.stringify(seedMarginPolicy));
    expect(result).toEqual(seedMarginPolicy);
  });

  it("returns object policies unchanged", () => {
    expect(parseBaseMarginPolicy(seedMarginPolicy)).toEqual(seedMarginPolicy);
  });

  it("falls back to the seeded default for legacy string values", () => {
    expect(parseBaseMarginPolicy("FIXED_RATE")).toEqual(seedMarginPolicy);
  });

  it("falls back to the seeded default for invalid JSON", () => {
    expect(parseBaseMarginPolicy("{not-json")).toEqual(seedMarginPolicy);
  });
});
