import { describe, it, expect } from "vitest";
import { computeRevenue } from "../revenue-calc";

describe("computeRevenue", () => {
  it("returns null when actualSales is null", () => {
    expect(computeRevenue(null, 100_000, 20, 10)).toBeNull();
  });

  it("returns null when actualSales is undefined (coerced to null)", () => {
    expect(computeRevenue(undefined as unknown as null, 0, 20, 10)).toBeNull();
  });

  it("computes correct values with typical inputs", () => {
    const result = computeRevenue(1_000_000, 50_000, 20, 10);
    expect(result).toEqual({
      netRevenue: 200_000, // floor(1_000_000 * 20 / 100)
      sellerCommission: 100_000, // floor(1_000_000 * 10 / 100)
      taxExpense: 0,
      operatingProfit: 850_000, // 1_000_000 - 100_000 - 50_000
    });
  });

  it("uses Math.floor for won-unit truncation", () => {
    // 333_333 * 33 / 100 = 109_999.89 → floor → 109_999
    const result = computeRevenue(333_333, 0, 33, 15);
    expect(result).toEqual({
      netRevenue: Math.floor((333_333 * 33) / 100), // 109_999
      sellerCommission: Math.floor((333_333 * 15) / 100), // 49_999
      taxExpense: 0,
      operatingProfit: 333_333 - Math.floor((333_333 * 15) / 100) - 0,
    });
  });

  it("treats null operatingExpense as 0", () => {
    const result = computeRevenue(500_000, null, 20, 10);
    expect(result).toEqual({
      netRevenue: 100_000,
      sellerCommission: 50_000,
      taxExpense: 0,
      operatingProfit: 450_000, // 500_000 - 50_000 - 0
    });
  });

  it("allows negative operatingProfit", () => {
    const result = computeRevenue(100_000, 500_000, 10, 5);
    expect(result).toEqual({
      netRevenue: 10_000, // floor(100_000 * 10 / 100)
      sellerCommission: 5_000, // floor(100_000 * 5 / 100)
      taxExpense: 0,
      operatingProfit: -405_000, // 100_000 - 5_000 - 500_000
    });
  });

  it("handles zero actualSales", () => {
    const result = computeRevenue(0, 10_000, 20, 10);
    expect(result).toEqual({
      netRevenue: 0,
      sellerCommission: 0,
      taxExpense: 0,
      operatingProfit: -10_000,
    });
  });

  it("handles zero margin rates", () => {
    const result = computeRevenue(1_000_000, 50_000, 0, 0);
    expect(result).toEqual({
      netRevenue: 0,
      sellerCommission: 0,
      taxExpense: 0,
      operatingProfit: 950_000,
    });
  });

  it("handles 100% margin rates", () => {
    const result = computeRevenue(1_000_000, 0, 100, 100);
    expect(result).toEqual({
      netRevenue: 1_000_000,
      sellerCommission: 1_000_000,
      taxExpense: 0,
      operatingProfit: 0,
    });
  });
});
