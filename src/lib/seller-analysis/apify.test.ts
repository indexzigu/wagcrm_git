import { afterEach, describe, expect, it } from "vitest";
import { getApifyToken } from "./apify";

// 시작 오프셋이 무작위여도 성립하는 라운드로빈 불변식으로 검증한다:
// 풀 크기만큼 연속 호출하면 모든 토큰이 정확히 한 번씩 나온다(시작점 무관).
const origTokens = process.env.APIFY_API_TOKENS;
const origSingle = process.env.APIFY_API_TOKEN;

afterEach(() => {
  if (origTokens === undefined) delete process.env.APIFY_API_TOKENS;
  else process.env.APIFY_API_TOKENS = origTokens;
  if (origSingle === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = origSingle;
});

function collect(n: number): string[] {
  return Array.from({ length: n }, () => getApifyToken() as string);
}

describe("getApifyToken 로테이션", () => {
  it("APIFY_API_TOKENS 풀을 라운드로빈으로 모두 사용한다(시작 오프셋 무관)", () => {
    process.env.APIFY_API_TOKENS = "a,b,c";
    delete process.env.APIFY_API_TOKEN;
    const got = collect(3);
    expect(new Set(got)).toEqual(new Set(["a", "b", "c"])); // 3연속 = 전 토큰 1회씩
  });

  it("단일 APIFY_API_TOKEN을 풀에 추가한다", () => {
    process.env.APIFY_API_TOKENS = "a,b,c";
    process.env.APIFY_API_TOKEN = "d";
    expect(new Set(collect(4))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("단일 토큰이 이미 풀에 있으면 중복 추가하지 않는다", () => {
    process.env.APIFY_API_TOKENS = "a,b,c";
    process.env.APIFY_API_TOKEN = "a";
    expect(new Set(collect(3))).toEqual(new Set(["a", "b", "c"]));
  });

  it("공백·빈 항목을 정리한다", () => {
    process.env.APIFY_API_TOKENS = " a , , b ";
    delete process.env.APIFY_API_TOKEN;
    expect(new Set(collect(2))).toEqual(new Set(["a", "b"]));
  });

  it("토큰이 하나도 없으면 undefined를 반환한다", () => {
    delete process.env.APIFY_API_TOKENS;
    delete process.env.APIFY_API_TOKEN;
    expect(getApifyToken()).toBeUndefined();
  });
});
