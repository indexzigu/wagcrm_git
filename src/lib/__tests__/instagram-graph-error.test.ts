// Graph BD 실패 분류의 **판정 방향**을 고정한다.
//
// 이 분류기가 틀리는 두 방향은 비용이 전혀 다르다:
//  - 전역 실패(토큰 만료·한도)를 계정 문제로 오인 → 갱신을 누를 때마다 유료 호출. 크레딧이
//    이 프로젝트의 실제 병목이라 가장 비싼 오답이다.
//  - 계정 문제를 전역으로 오인 → 그 셀러가 갱신 불가.
// 그래서 아래 테스트는 "전역 클래스는 절대 폴백하지 않는다"를 코드 단위로 못 박는다.
import { describe, expect, it } from "vitest";
import { classifyGraphBdFailure } from "@/lib/instagram-graph-error";

function graphError(code: number, subcode?: number, message = "err") {
  return { error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}) } };
}

describe("classifyGraphBdFailure", () => {
  it("개인계정·미존재 핸들(code 100)은 계정 문제 → 폴백 대상", () => {
    // BD 는 비즈니스·크리에이터 계정만 조회 가능하다. 개인계정은 여기로 떨어진다.
    const result = classifyGraphBdFailure({
      httpStatus: 400,
      body: graphError(100, 33, "Unsupported get request."),
    });
    expect(result.kind).toBe("account");
    expect(result.shouldFallback).toBe(true);
    expect(result.code).toBe(100);
    expect(result.subcode).toBe(33);
  });

  it("HTTP 200 + 빈 페이로드도 계정 문제로 본다", () => {
    // BD 가 business_discovery 를 아예 안 실어 보내는 경우 — 에러 코드가 없다.
    const result = classifyGraphBdFailure({ httpStatus: 200, body: { id: "17841400000000000" } });
    expect(result.kind).toBe("account");
    expect(result.shouldFallback).toBe(true);
    expect(result.message).toBe("HTTP 200");
  });

  it.each([
    [190, "OAuth 토큰 만료"],
    [102, "세션 만료"],
    [10, "권한 없음"],
    [200, "권한 오류"],
    [2500, "유효 토큰 필요"],
    [3, "앱 기능 권한 없음"],
  ])("자격증명 코드 %i(%s)은 auth → 폴백 금지", (code) => {
    const result = classifyGraphBdFailure({ httpStatus: 400, body: graphError(code) });
    expect(result.kind).toBe("auth");
    expect(result.shouldFallback).toBe(false);
  });

  it.each([[4], [17], [32], [613]])("호출 한도 코드 %i는 rate_limit → 폴백 금지", (code) => {
    const result = classifyGraphBdFailure({ httpStatus: 400, body: graphError(code) });
    expect(result.kind).toBe("rate_limit");
    expect(result.shouldFallback).toBe(false);
  });

  it("Instagram 플랫폼 한도(80000번대)는 구간으로 막는다 — 신규 코드가 새지 않게", () => {
    for (const code of [80001, 80004, 80999]) {
      const result = classifyGraphBdFailure({ httpStatus: 400, body: graphError(code) });
      expect(result.kind).toBe("rate_limit");
      expect(result.shouldFallback).toBe(false);
    }
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "transient"],
    [503, "transient"],
  ])("코드가 없으면 HTTP %i로 보정한다 → %s", (status, kind) => {
    const result = classifyGraphBdFailure({ httpStatus: status, body: null });
    expect(result.kind).toBe(kind);
    expect(result.shouldFallback).toBe(false);
  });

  it("본문 코드가 HTTP 상태를 이긴다 — 토큰 만료가 400으로 오는 게 정상이다", () => {
    // HTTP 만 보면 400 → 계정 문제로 오인하고 유료 호출이 나간다. 실제로 막고 싶은 회귀.
    const result = classifyGraphBdFailure({
      httpStatus: 400,
      body: graphError(190, 463, "Error validating access token: Session has expired"),
    });
    expect(result.kind).toBe("auth");
    expect(result.shouldFallback).toBe(false);
    expect(result.message).toContain("code 190/463");
  });

  it("한도 코드가 200 OK 로 위장해도 폴백하지 않는다", () => {
    const result = classifyGraphBdFailure({ httpStatus: 200, body: graphError(4) });
    expect(result.shouldFallback).toBe(false);
  });
});
