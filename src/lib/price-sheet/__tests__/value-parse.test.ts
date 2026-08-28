import { describe, expect, it } from "vitest";
import { parseNumericCell, parseRateCell, parseFieldValue } from "../value-parse";

describe("parseNumericCell", () => {
  it("콤마 포함 문자열을 숫자로 변환", () => {
    expect(parseNumericCell("30,900")).toBe(30900);
  });
  it("원화 기호 제거", () => {
    expect(parseNumericCell("30900원")).toBe(30900);
  });
  it("숫자 원본은 그대로", () => {
    expect(parseNumericCell(500)).toBe(500);
  });
  it("빈 값은 null", () => {
    expect(parseNumericCell(null)).toBeNull();
    expect(parseNumericCell("")).toBeNull();
  });
  it("파싱 불가 문자열은 null (지어내지 않음)", () => {
    expect(parseNumericCell("해당없음")).toBeNull();
  });
});

describe("parseRateCell", () => {
  it("이미 소수인 값(0.33)은 그대로 유지", () => {
    expect(parseRateCell(0.33)).toBeCloseTo(0.33, 5);
  });
  it("1보다 큰 숫자(33)는 /100", () => {
    expect(parseRateCell(33)).toBeCloseTo(0.33, 5);
  });
  it("퍼센트 문자열(30%)은 /100", () => {
    expect(parseRateCell("30%")).toBeCloseTo(0.3, 5);
  });
  it("빈 값은 null", () => {
    expect(parseRateCell(null)).toBeNull();
  });
});

describe("parseFieldValue", () => {
  it("productName은 문자열 trim, 빈 문자열은 null", () => {
    expect(parseFieldValue("productName", "  상품A  ")).toBe("상품A");
    expect(parseFieldValue("productName", "")).toBeNull();
  });
  it("commissionRate는 rate 파싱 경로를 탄다", () => {
    expect(parseFieldValue("commissionRate", "33%")).toBeCloseTo(0.33, 5);
  });
  it("sellingPrice는 numeric 파싱 경로를 탄다", () => {
    expect(parseFieldValue("sellingPrice", "30,900")).toBe(30900);
  });
});
