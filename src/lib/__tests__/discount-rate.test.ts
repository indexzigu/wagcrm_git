import { describe, it, expect } from "vitest";
import { computeDiscountRate, formatDiscountRate } from "../discount-rate";

describe("computeDiscountRate", () => {
  it("calculates correct discount rate for valid inputs", () => {
    // (100 - 80) / 100 * 100 = 20.0
    expect(computeDiscountRate(100, 80)).toBe(20.0);
  });

  it("rounds to 1 decimal place", () => {
    // (30000 - 19900) / 30000 * 100 = 33.666... → 33.7
    expect(computeDiscountRate(30000, 19900)).toBe(33.7);
  });

  it("returns 0 when listPrice equals sellingPrice", () => {
    expect(computeDiscountRate(500, 500)).toBe(0);
  });

  it("returns negative rate when sellingPrice exceeds listPrice", () => {
    // (100 - 120) / 100 * 100 = -20.0
    expect(computeDiscountRate(100, 120)).toBe(-20.0);
  });

  it("returns null when listPrice is null", () => {
    expect(computeDiscountRate(null, 80)).toBeNull();
  });

  it("returns null when listPrice is undefined", () => {
    expect(computeDiscountRate(undefined, 80)).toBeNull();
  });

  it("returns null when listPrice is zero", () => {
    expect(computeDiscountRate(0, 80)).toBeNull();
  });

  it("returns null when listPrice is negative", () => {
    expect(computeDiscountRate(-10, 80)).toBeNull();
  });

  it("returns null when sellingPrice is null", () => {
    expect(computeDiscountRate(100, null)).toBeNull();
  });

  it("returns null when sellingPrice is undefined", () => {
    expect(computeDiscountRate(100, undefined)).toBeNull();
  });

  it("handles sellingPrice of zero", () => {
    // (100 - 0) / 100 * 100 = 100.0
    expect(computeDiscountRate(100, 0)).toBe(100.0);
  });
});

describe("formatDiscountRate", () => {
  it("formats a positive rate with percent sign", () => {
    expect(formatDiscountRate(12.5)).toBe("12.5%");
  });

  it("formats zero rate", () => {
    expect(formatDiscountRate(0)).toBe("0%");
  });

  it("formats negative rate", () => {
    expect(formatDiscountRate(-5.3)).toBe("-5.3%");
  });

  it("returns dash for null", () => {
    expect(formatDiscountRate(null)).toBe("-");
  });

  it("formats integer rate without trailing decimal", () => {
    expect(formatDiscountRate(20)).toBe("20%");
  });
});
