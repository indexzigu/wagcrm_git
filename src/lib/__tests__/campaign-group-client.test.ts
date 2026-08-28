// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  dismissSuggestion,
  formatGroupLabel,
  isSuggestionDismissed,
  suggestionDismissKey,
} from "../campaign-group-client";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("formatGroupLabel", () => {
  it("name이 있으면 그대로 쓴다", () => {
    expect(formatGroupLabel({ name: "[가온] 비타민 외 2건", sellerName: "가온" })).toBe(
      "[가온] 비타민 외 2건",
    );
  });

  it("name이 null이면 셀러 라벨 기반 폴백을 만든다", () => {
    expect(formatGroupLabel({ name: null, sellerName: "가온" })).toBe("가온 그룹");
  });

  it("name이 공백뿐이면 폴백을 쓴다", () => {
    expect(formatGroupLabel({ name: "   ", sellerName: "가온" })).toBe("가온 그룹");
  });
});

describe("세션 억제(dismiss)", () => {
  it("키 포맷은 cg1:dismiss:{campaignId}:{groupId}", () => {
    expect(suggestionDismissKey("c1", "g1")).toBe("cg1:dismiss:c1:g1");
  });

  it("기본은 미억제, dismiss 후 억제된다", () => {
    expect(isSuggestionDismissed("c1", "g1")).toBe(false);
    dismissSuggestion("c1", "g1");
    expect(isSuggestionDismissed("c1", "g1")).toBe(true);
  });

  it("억제는 (campaignId, groupId) 쌍 단위 — 다른 그룹은 영향 없음", () => {
    dismissSuggestion("c1", "g1");
    expect(isSuggestionDismissed("c1", "g2")).toBe(false);
    expect(isSuggestionDismissed("c2", "g1")).toBe(false);
  });
});
