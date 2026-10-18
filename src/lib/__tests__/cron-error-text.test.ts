import { describe, expect, it } from "vitest";
import { describeErrorChain } from "../cron-error-text";

describe("describeErrorChain", () => {
  it("cause 를 끝까지 펼친다", () => {
    const inner = new Error("Proxy response (407) !== 200 when HTTP Tunneling");
    const mid = new Error("tunnel failed", { cause: inner });
    expect(describeErrorChain(new TypeError("fetch failed", { cause: mid }))).toBe(
      "fetch failed <- tunnel failed <- Proxy response (407) !== 200 when HTTP Tunneling",
    );
  });
  it("순환 cause 에서 멈춘다", () => {
    const e = new Error("loop");
    (e as { cause?: unknown }).cause = e;
    expect(describeErrorChain(e)).toBe("loop");
  });
  it("Error 가 아닌 throw 도 문자열이 된다", () => {
    expect(describeErrorChain("x")).toBe("x");
    expect(describeErrorChain({ code: 1 })).toBe('{"code":1}');
  });
  it("1000자에서 자른다", () => {
    expect(describeErrorChain(new Error("a".repeat(5000))).length).toBe(1000);
  });
  it("maxDepth 를 넘는 사슬은 자른다", () => {
    let e: Error = new Error("e0");
    for (let i = 1; i < 10; i++) e = new Error(`e${i}`, { cause: e });
    expect(describeErrorChain(e, 3)).toBe("e9 <- e8 <- e7");
  });
});
