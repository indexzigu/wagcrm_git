import { describe, expect, it } from "vitest";
import { getCell, rowToRawCells, gridToPromptText } from "../sheet-grid";

describe("getCell", () => {
  const grid = [
    ["a", "b"],
    ["c", "d"],
  ];
  it("범위 안 값을 반환", () => {
    expect(getCell(grid, 1, 0)).toBe("c");
  });
  it("범위 밖 행은 null", () => {
    expect(getCell(grid, 5, 0)).toBeNull();
  });
  it("범위 밖 열은 null", () => {
    expect(getCell(grid, 0, 5)).toBeNull();
  });
});

describe("rowToRawCells", () => {
  it("배열을 인덱스 문자열 키 객체로 변환", () => {
    expect(rowToRawCells(["x", "y"])).toEqual({ "0": "x", "1": "y" });
  });
  it("undefined 행은 빈 객체", () => {
    expect(rowToRawCells(undefined)).toEqual({});
  });
});

describe("gridToPromptText", () => {
  it("빈 셀이 있는 행은 값 있는 셀만 표시", () => {
    const text = gridToPromptText([["A", null, "C"]]);
    expect(text).toContain("R0|");
    expect(text).toContain("0:A");
    expect(text).toContain("2:C");
    expect(text).not.toContain("1:");
  });
  it("완전 빈 행은 스킵", () => {
    const text = gridToPromptText([[null, null], ["A", null]]);
    expect(text.split("\n")).toHaveLength(1);
  });
});
