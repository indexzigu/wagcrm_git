import { describe, it, expect } from "vitest";
import { formatYAxisLabel, computeChartLeftMargin } from "../y-axis-format";

describe("formatYAxisLabel", () => {
  it("returns '0' for zero", () => {
    expect(formatYAxisLabel(0)).toBe("0");
  });

  it("formats values below 1,000,000 with commas", () => {
    expect(formatYAxisLabel(500)).toBe("500");
    expect(formatYAxisLabel(1000)).toBe("1,000");
    expect(formatYAxisLabel(500000)).toBe("500,000");
    expect(formatYAxisLabel(999999)).toBe("999,999");
  });

  it("formats values ≥ 1,000,000 with 만 unit", () => {
    expect(formatYAxisLabel(1_000_000)).toBe("100만");
    expect(formatYAxisLabel(5_000_000)).toBe("500만");
    expect(formatYAxisLabel(10_000_000)).toBe("1,000만");
    expect(formatYAxisLabel(50_000_000)).toBe("5,000만");
    expect(formatYAxisLabel(99_000_000)).toBe("9,900만");
  });

  it("formats values ≥ 100,000,000 with 억 unit", () => {
    expect(formatYAxisLabel(100_000_000)).toBe("1억");
    expect(formatYAxisLabel(150_000_000)).toBe("1.5억");
    expect(formatYAxisLabel(200_000_000)).toBe("2억");
    expect(formatYAxisLabel(1_000_000_000)).toBe("10억");
    expect(formatYAxisLabel(1_500_000_000)).toBe("15억");
  });

  it("handles 억 with clean decimal values", () => {
    expect(formatYAxisLabel(250_000_000)).toBe("2.5억");
    expect(formatYAxisLabel(300_000_000)).toBe("3억");
    expect(formatYAxisLabel(350_000_000)).toBe("3.5억");
  });

  it("handles negative values", () => {
    expect(formatYAxisLabel(-1_000_000)).toBe("-100만");
    expect(formatYAxisLabel(-100_000_000)).toBe("-1억");
  });
});

describe("computeChartLeftMargin", () => {
  it("returns minimum 40px for small values", () => {
    expect(computeChartLeftMargin(0)).toBeGreaterThanOrEqual(40);
    expect(computeChartLeftMargin(100)).toBeGreaterThanOrEqual(40);
  });

  it("returns larger margin for larger values with longer labels", () => {
    const smallMargin = computeChartLeftMargin(100);
    const largeMargin = computeChartLeftMargin(10_000_000);
    expect(largeMargin).toBeGreaterThanOrEqual(smallMargin);
  });

  it("does not exceed 80px maximum", () => {
    expect(computeChartLeftMargin(10_000_000_000)).toBeLessThanOrEqual(80);
  });

  it("returns a number (pixel value) for any non-negative input", () => {
    const values = [0, 1000, 1_000_000, 100_000_000, 1_000_000_000];
    for (const v of values) {
      const margin = computeChartLeftMargin(v);
      expect(typeof margin).toBe("number");
      expect(margin).toBeGreaterThanOrEqual(40);
      expect(margin).toBeLessThanOrEqual(80);
    }
  });
});
