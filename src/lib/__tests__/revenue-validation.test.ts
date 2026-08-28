import { describe, it, expect } from "vitest";
import { validateRevenueField } from "../revenue-validation";

describe("validateRevenueField", () => {
  describe("currency fields", () => {
    it("accepts valid currency values", () => {
      expect(validateRevenueField("0", "currency")).toBeNull();
      expect(validateRevenueField("100", "currency")).toBeNull();
      expect(validateRevenueField("999999999", "currency")).toBeNull();
      expect(validateRevenueField("123.45", "currency")).toBeNull();
      expect(validateRevenueField("0.99", "currency")).toBeNull();
      expect(validateRevenueField("1.5", "currency")).toBeNull();
    });

    it("accepts empty string (nullable)", () => {
      expect(validateRevenueField("", "currency")).toBeNull();
    });

    it("rejects non-numeric characters", () => {
      expect(validateRevenueField("abc", "currency")).not.toBeNull();
      expect(validateRevenueField("12a", "currency")).not.toBeNull();
      expect(validateRevenueField("-5", "currency")).not.toBeNull();
      expect(validateRevenueField("1,000", "currency")).not.toBeNull();
    });

    it("rejects values exceeding maximum", () => {
      expect(validateRevenueField("1000000000", "currency")).not.toBeNull();
      expect(validateRevenueField("9999999999", "currency")).not.toBeNull();
    });

    it("rejects more than 2 decimal places", () => {
      expect(validateRevenueField("1.234", "currency")).not.toBeNull();
      expect(validateRevenueField("0.001", "currency")).not.toBeNull();
    });
  });

  describe("integer fields", () => {
    it("accepts valid integer values", () => {
      expect(validateRevenueField("0", "integer")).toBeNull();
      expect(validateRevenueField("100", "integer")).toBeNull();
      expect(validateRevenueField("999999", "integer")).toBeNull();
    });

    it("accepts empty string (nullable)", () => {
      expect(validateRevenueField("", "integer")).toBeNull();
    });

    it("rejects decimal values", () => {
      expect(validateRevenueField("1.5", "integer")).not.toBeNull();
      expect(validateRevenueField("0.1", "integer")).not.toBeNull();
    });

    it("rejects non-numeric characters", () => {
      expect(validateRevenueField("abc", "integer")).not.toBeNull();
      expect(validateRevenueField("12a", "integer")).not.toBeNull();
      expect(validateRevenueField("-1", "integer")).not.toBeNull();
    });

    it("rejects values exceeding maximum", () => {
      expect(validateRevenueField("1000000", "integer")).not.toBeNull();
      expect(validateRevenueField("9999999", "integer")).not.toBeNull();
    });
  });
});
