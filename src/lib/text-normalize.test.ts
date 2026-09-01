import { describe, it, expect } from "vitest";
import { normalizeForCompare, toNfc } from "./text-normalize";

describe("toNfc", () => {
  it("자모 분리형을 조합형으로 맞춘다", () => {
    const nfd = "세금계산서".normalize("NFD");
    expect(nfd).not.toBe("세금계산서"); // 눈에는 같지만 다른 문자열이다
    expect(toNfc(nfd)).toBe("세금계산서");
  });

  it("이미 조합형이면 그대로 둔다", () => {
    expect(toNfc("세금계산서")).toBe("세금계산서");
  });
});

describe("normalizeForCompare", () => {
  it("NFC · 공백 제거 · 소문자화를 함께 건다", () => {
    expect(normalizeForCompare(" CJ 택배 ".normalize("NFD"))).toBe("cj택배");
  });

  it("**양쪽을 같은 함수로 접어야** 공백 있는 이름이 매칭된다", () => {
    // 🔴 종전에는 한쪽(needle)만 소문자화하고 공백은 안 지웠는데 다른 쪽(haystack)은
    //    지워서, **이름에 공백이 있는 셀러는 제목·파일명 매칭이 원리적으로 실패**했다.
    //    한 함수로 모으면서 함께 닫힌 자리라 여기서 못박는다(교차 검증 지적).
    const 제목 = normalizeForCompare("[발주서] 우리 브랜드 260624 회신");
    expect(제목.includes(normalizeForCompare("우리 브랜드"))).toBe(true);
  });

  it("정확 일치가 필요한 자리에는 쓰지 않는다 — 공백·대소문자를 뭉갠다", () => {
    expect(normalizeForCompare("세금 계산서")).toBe(normalizeForCompare("세금계산서"));
  });
});
