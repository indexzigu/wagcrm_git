import { describe, it, expect } from "vitest";
import { extractStoryItems } from "../story-viewer-fetch";

// 뷰어 응답 해석 — 「스토리 없음」은 정상 빈 배열, 알 수 없는 모양은 던진다(뷰어 변경을 0건으로 삼키지 않게).
describe("extractStoryItems", () => {
  it("스토리 없는 날의 v2 응답은 빈 배열이다(2026-10-20 실측 모양)", () => {
    expect(extractStoryItems({ result: { items: [], pageInfo: {}, owner: { username: "x" } } }, "v")).toEqual([]);
  });

  it("v1 배열 응답은 그대로 돌려준다", () => {
    expect(extractStoryItems({ result: [{ id: 1 }] }, "v")).toEqual([{ id: 1 }]);
  });

  it("v2 항목에는 작성자를 붙인다", () => {
    const items = extractStoryItems({ result: { items: [{ id: 1 }], owner: { username: "x" } } }, "v");
    expect(items).toEqual([{ id: 1, owner: { username: "x" } }]);
  });

  it.each([
    [{ result: { data: [] } }, "result=object[data]"],
    [{ result: null }, "result=null"],
    [{ stories: [] }, "result=없음"],
    [{ result: "nope" }, "result=string"],
  ])("알 수 없는 모양은 겉모양을 담아 던진다 %#", (parsed, shape) => {
    expect(() => extractStoryItems(parsed, "v")).toThrow(/형식 불일치/);
    expect(() => extractStoryItems(parsed, "v")).toThrow(shape);
  });

  it("오류 메시지에 값(계정·내용)을 싣지 않는다", () => {
    expect.assertions(2);
    try {
      extractStoryItems({ result: { secretField: "private-handle" } }, "v");
    } catch (e) {
      expect(String(e)).not.toContain("private-handle");
      expect(String(e)).toContain("secretField");
    }
  });
});
