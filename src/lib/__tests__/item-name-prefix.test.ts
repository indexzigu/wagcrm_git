import { describe, it, expect } from "vitest";
import { extractCommonItemPrefix } from "../item-name-prefix";

describe("extractCommonItemPrefix", () => {
  it("한 캠페인 옵션 리스트 — 공통 접두어(딜명·카테고리)를 접고 옵션값만 남긴다", () => {
    const names = [
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-115] 10000mAh 화이트",
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-115] 20000mAh 블랙",
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-123] 10000mAh 화이트",
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-123] 20000mAh 블랙",
    ];

    const { shared, labels } = extractCommonItemPrefix(names);

    // 옵션코드가 반반(VA-115/VA-123)이라 코드 위치에서 멈춰 코드가 꼬리에 남는다.
    expect(shared).toBe("[김본명 X 보바] 보조 배터리 마켓 · 보조배터리");
    expect(labels).toEqual([
      "[VA-115] 10000mAh 화이트",
      "[VA-115] 20000mAh 블랙",
      "[VA-123] 10000mAh 화이트",
      "[VA-123] 20000mAh 블랙",
    ]);
  });

  it("사은품/이종상품 outlier — 접두어가 다르면 원문을 그대로 보존한다", () => {
    const names = [
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-115] 10000mAh 화이트",
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-123] 20000mAh 블랙",
      "[김본명 X 보바] 보조 배터리 마켓 · 보조배터리: [VA-115] 5000mAh 핑크",
      "아이보리 · [VA-998] 파우치: 아이보리",
    ];

    const { shared, labels } = extractCommonItemPrefix(names);

    expect(shared).toBe("[김본명 X 보바] 보조 배터리 마켓 · 보조배터리");
    expect(labels[0]).toBe("[VA-115] 10000mAh 화이트");
    expect(labels[1]).toBe("[VA-123] 20000mAh 블랙");
    expect(labels[2]).toBe("[VA-115] 5000mAh 핑크");
    // outlier 는 공통 접두어에 매칭되지 않아 원문 유지
    expect(labels[3]).toBe("아이보리 · [VA-998] 파우치: 아이보리");
  });

  it("공통 접두어가 없으면 원문을 그대로 통과시킨다", () => {
    const names = ["사과 1kg", "바나나 2kg", "포도 3kg"];
    const result = extractCommonItemPrefix(names);
    expect(result.shared).toBe("");
    expect(result.labels).toEqual(names);
  });

  it("항목이 1개면 아무것도 접지 않는다", () => {
    const names = ["딸기 · 500g"];
    const result = extractCommonItemPrefix(names);
    expect(result.shared).toBe("");
    expect(result.labels).toEqual(names);
  });

  it("접두어를 떼면 빈 꼬리가 되는 항목은 원문을 유지한다(빈 행 방지)", () => {
    const names = ["옵션 A", "옵션 B", "옵션"];
    const { shared, labels } = extractCommonItemPrefix(names);
    expect(shared).toBe("옵션");
    expect(labels).toEqual(["A", "B", "옵션"]);
  });

  it("실제로 2개 미만만 짧아지면(실익 없음) 원문을 유지한다", () => {
    const names = ["세트 구성", "세트", "세트"];
    const result = extractCommonItemPrefix(names);
    expect(result.shared).toBe("");
    expect(result.labels).toEqual(names);
  });

  it("labels 는 항상 입력과 1:1 길이를 유지한다", () => {
    const names = [
      "브랜드 딜 · 옵션: 빨강",
      "브랜드 딜 · 옵션: 파랑",
      "전혀 다른 상품",
    ];
    const { labels } = extractCommonItemPrefix(names);
    expect(labels).toHaveLength(names.length);
    expect(labels[2]).toBe("전혀 다른 상품");
  });
});
