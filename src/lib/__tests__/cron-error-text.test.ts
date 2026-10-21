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
  it("메시지가 빈 오류는 이름으로, 이름도 없으면 「알 수 없는 오류」로 쓴다(빈 문자열이 실패를 지우지 않게)", () => {
    expect(describeErrorChain(new Error())).toBe("Error");
    const abort = new Error("");
    abort.name = "AbortError";
    expect(describeErrorChain(abort)).toBe("AbortError");
    const nameless = new Error("");
    nameless.name = "";
    expect(describeErrorChain(nameless)).toBe("알 수 없는 오류");
    expect(describeErrorChain(new Error("fetch failed", { cause: new Error() }))).toBe("fetch failed <- Error");
  });
  it("Error 가 아니어도 message 문자열이 있으면 그것을 쓰고 cause 를 잇는다", () => {
    expect(describeErrorChain({ message: "boom", code: "E1" })).toBe("boom");
    expect(describeErrorChain({ message: "outer", cause: new Error("inner") })).toBe("outer <- inner");
  });
  it("빈 값 throw 도 빈 문자열이 되지 않는다", () => {
    expect(describeErrorChain("")).toBe("알 수 없는 오류");
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

describe("describeErrorChain — AggregateError", () => {
  it("errors 배열 안의 원인(프록시 407)을 펼쳐 한도 소진으로 분류되게 한다", async () => {
    const { classifyCronError } = await import("../cron-error-kind");
    const aggregate = new AggregateError(
      [new Error("Proxy response (407) !== 200 when HTTP Tunneling"), new Error("connect ECONNREFUSED")],
      "all attempts failed",
    );
    const text = describeErrorChain(new TypeError("fetch failed", { cause: aggregate }));
    expect(text).toBe(
      "fetch failed <- all attempts failed <- [Proxy response (407) !== 200 when HTTP Tunneling | connect ECONNREFUSED]",
    );
    expect(classifyCronError(text)).toBe("proxy_quota");
  });
  it("자기 자신을 품은 묶음 오류에서도 멈춘다", () => {
    const loop = new AggregateError([], "loop");
    (loop as unknown as { errors: unknown[] }).errors = [loop, new AggregateError([loop], "nested")];
    expect(describeErrorChain(loop)).toBe("loop <- [loop | nested]");
  });
  it("errors 가 비면 지금처럼 끝낸다", () => {
    expect(describeErrorChain(new AggregateError([], "all attempts failed"))).toBe("all attempts failed");
  });
});
