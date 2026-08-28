/**
 * CG-1 캠페인 그룹 이름 유틸 단위 테스트 (D4 포맷).
 */

import { describe, it, expect } from "vitest";
import { generateGroupName } from "../campaign-group-name";

describe("generateGroupName", () => {
  it("멤버 3건 → '[셀러라벨] 대표딜명 외 2건'", () => {
    expect(generateGroupName("비타민", "가온", 3)).toBe("[가온] 비타민 외 2건");
  });

  it("멤버 2건 → '외 1건'", () => {
    expect(generateGroupName("글로우 앰플", "미나", 2)).toBe("[미나] 글로우 앰플 외 1건");
  });

  it("멤버 1건(비정상)이면 접미사 없이", () => {
    expect(generateGroupName("딜", "셀러", 1)).toBe("[셀러] 딜");
  });

  it("대표딜명이 null이면 null", () => {
    expect(generateGroupName(null, "가온", 3)).toBeNull();
  });

  it("셀러라벨이 null이면 null", () => {
    expect(generateGroupName("비타민", null, 3)).toBeNull();
  });

  it("대표딜명이 빈 문자열이면 null", () => {
    expect(generateGroupName("", "가온", 3)).toBeNull();
  });

  it("셀러라벨이 빈 문자열이면 null", () => {
    expect(generateGroupName("비타민", "", 3)).toBeNull();
  });

  it("100자에서 절단", () => {
    const longDeal = "가".repeat(120);
    const result = generateGroupName(longDeal, "라벨", 5);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
  });
});
