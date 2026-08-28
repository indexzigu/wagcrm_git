/**
 * 크론 인증의 **프로퍼티 기반** 테스트 — 예시 몇 개가 아니라 생성된 입력 전 범위에서
 * 불변식이 유지되는지 본다. 예시 기반 계약은 `src/lib/__tests__/cron-auth.test.ts` 소관.
 *
 * ## 이 파일이 한 번 무의미해졌던 이력 (2026-08-05 정리)
 *
 * 원래 이 파일은 프로덕션 코드를 import 하지 않고 **인증 로직을 자체적으로 다시 구현해서**
 * 그것을 테스트했다(부수효과 회피가 명분이었다). 그래서 다음 두 가지가 동시에 성립했다:
 *
 * - 라우트 18개의 인증이 실제로 갈라져 있었고 그중 2건이 `CRON_SECRET` 미설정 시 **인증 없이
 *   통과**하는 fail-open 이었는데, 이 테스트는 **5건 전부 초록불**이었다. 자기가 정의한
 *   함수를 자기가 테스트했으니 프로덕션이 어떻게 바뀌든 통과한다.
 * - 사본은 시크릿을 **인자로 받았다**(`verifyCronAuth(request, cronSecret)`). 그래서 이번에
 *   고친 결함의 핵심인 **"환경변수가 없을 때 어떻게 되는가"를 구조적으로 표현할 수 없었다.**
 *
 * 교훈은 "프로덕션 코드를 import 하지 않는 테스트는 아무것도 보증하지 않는다" 하나다.
 * 이제 이 파일은 `@/lib/cron-auth` 의 **실제 SSOT** 를 부르고, env 를 직접 조작해
 * 미설정 케이스까지 프로퍼티로 덮는다. 사본 재발은
 * `src/lib/__tests__/api-route-auth-coverage.contract.test.ts` C3 가 소스 스캔으로 막는다
 * (그 스캔 범위가 `route.ts` 뿐이라 이 파일을 놓쳤던 것도 같은 정리에서 넓혔다).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import { verifyCronAuth, verifyCronQuerySecret } from "@/lib/cron-auth";

const ORIGINAL = process.env.CRON_SECRET;

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
}

afterEach(() => {
  setSecret(ORIGINAL);
});

/** Authorization 헤더를 선택적으로 단 요청. */
function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return new Request("https://example.com/api/cron/collect-instagram", { headers });
}

/** `?secret=` 쿼리를 선택적으로 단 요청(외부 웹훅 형태). */
function makeQueryRequest(secret?: string): Request {
  const base = "https://example.com/api/cron/apify-webhook/youtube";
  return new Request(secret === undefined ? base : `${base}?secret=${encodeURIComponent(secret)}`);
}

/** 그럴듯한 CRON_SECRET: 영숫자 + 흔한 특수문자, 8~64자. */
const cronSecretArb = fc
  .stringMatching(/^[A-Za-z0-9_\-!@#$%^&*]{8,64}$/)
  .filter((s) => s.length >= 8);

/** 제어문자 없는 임의 문자열(헤더 값으로 안전). */
const printableString = fc.string({ minLength: 1, maxLength: 64 });

// ---------------------------------------------------------------------------
// 음성 대조군 — 이 파일이 진짜 프로덕션 코드를 보고 있는가
// ---------------------------------------------------------------------------

describe("P0: 이 테스트는 SSOT 를 테스트한다", () => {
  it("import 한 것이 실제 함수다(사본 재발 시 여기서 먼저 깨진다)", () => {
    expect(typeof verifyCronAuth).toBe("function");
    expect(typeof verifyCronQuerySecret).toBe("function");
    // 시크릿을 인자로 받지 않는다 — env 를 직접 읽는 것이 fail-closed 계약의 전제다.
    expect(verifyCronAuth.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property 7: 크론 인증은 잘못된 자격증명을 거부한다
// ---------------------------------------------------------------------------

describe("Property 7: 크론 인증은 잘못된 자격증명을 거부한다", () => {
  it("7a — Authorization 헤더가 없으면 어떤 시크릿에 대해서도 거부한다", () => {
    fc.assert(
      fc.property(cronSecretArb, (secret) => {
        setSecret(secret);
        expect(verifyCronAuth(makeRequest())).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("7b — Bearer 토큰이 시크릿과 다르면 거부한다", () => {
    fc.assert(
      fc.property(cronSecretArb, printableString, (secret, wrongToken) => {
        fc.pre(wrongToken !== secret);
        setSecret(secret);
        expect(verifyCronAuth(makeRequest(`Bearer ${wrongToken}`))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("7c — 정확한 Bearer 토큰은 통과한다(양성 대조군)", () => {
    fc.assert(
      fc.property(cronSecretArb, (secret) => {
        setSecret(secret);
        expect(verifyCronAuth(makeRequest(`Bearer ${secret}`))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("7d — Bearer 가 아닌 스킴은 거부한다", () => {
    const nonBearerSchemes = fc.oneof(
      fc.constant("Basic"),
      fc.constant("Token"),
      fc.constant("Digest"),
      fc.constant(""),
    );

    fc.assert(
      fc.property(cronSecretArb, nonBearerSchemes, (secret, scheme) => {
        setSecret(secret);
        const headerValue = scheme ? `${scheme} ${secret}` : secret;
        expect(verifyCronAuth(makeRequest(headerValue))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: 시크릿이 없으면 아무도 통과하지 못한다 (fail-closed)
//
// ⚠️ 종전 사본은 시크릿을 인자로 받아 이 프로퍼티를 **표현할 수조차 없었다.**
// 실제 결함 2건이 정확히 이 영역에 있었으므로 여기가 이 파일의 존재 이유다.
// ---------------------------------------------------------------------------

describe("Property 8: CRON_SECRET 미설정이면 어떤 입력도 통과하지 못한다", () => {
  it("8a — 임의의 Authorization 헤더로도 통과하지 못한다", () => {
    fc.assert(
      fc.property(printableString, (anyToken) => {
        setSecret(undefined);
        expect(verifyCronAuth(makeRequest(anyToken))).toBe(false);
        expect(verifyCronAuth(makeRequest(`Bearer ${anyToken}`))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('8b — "Bearer undefined" 리터럴로도 통과하지 못한다(구 사본 16건의 회귀)', () => {
    setSecret(undefined);
    // 종전 사본은 기대값을 `Bearer ${process.env.CRON_SECRET}` 로 만들어, 미설정 시
    // 문자열 "Bearer undefined" 가 됐다 — 그 리터럴을 보내면 그대로 통과했다.
    expect(verifyCronAuth(makeRequest("Bearer undefined"))).toBe(false);
    expect(verifyCronAuth(makeRequest("Bearer null"))).toBe(false);
    expect(verifyCronAuth(makeRequest("Bearer "))).toBe(false);
    expect(verifyCronAuth(makeRequest())).toBe(false);
  });

  it("8c — 빈 문자열 시크릿은 미설정과 같이 취급한다", () => {
    fc.assert(
      fc.property(printableString, (anyToken) => {
        setSecret("");
        expect(verifyCronAuth(makeRequest(`Bearer ${anyToken}`))).toBe(false);
        expect(verifyCronAuth(makeRequest("Bearer "))).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: 쿼리형(외부 웹훅 전용)도 같은 계약을 따른다
// ---------------------------------------------------------------------------

describe("Property 9: 쿼리형 시크릿 검증", () => {
  it("9a — 정확한 secret 쿼리는 통과한다(양성 대조군)", () => {
    fc.assert(
      fc.property(cronSecretArb, (secret) => {
        setSecret(secret);
        expect(verifyCronQuerySecret(makeQueryRequest(secret))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("9b — 값이 다르거나 없으면 거부한다", () => {
    fc.assert(
      fc.property(cronSecretArb, printableString, (secret, wrong) => {
        fc.pre(wrong !== secret);
        setSecret(secret);
        expect(verifyCronQuerySecret(makeQueryRequest(wrong))).toBe(false);
        expect(verifyCronQuerySecret(makeQueryRequest())).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("9c — CRON_SECRET 미설정이면 무엇으로도 통과하지 못한다", () => {
    fc.assert(
      fc.property(printableString, (anyValue) => {
        setSecret(undefined);
        expect(verifyCronQuerySecret(makeQueryRequest(anyValue))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("9d — 헤더로는 쿼리형을 통과할 수 없고, 그 반대도 마찬가지다", () => {
    const secret = "cross-channel-check-value";
    setSecret(secret);
    // 쿼리 검증기는 헤더를 보지 않는다.
    expect(verifyCronQuerySecret(makeRequest(`Bearer ${secret}`))).toBe(false);
    // 헤더 검증기는 쿼리를 보지 않는다.
    expect(verifyCronAuth(makeQueryRequest(secret))).toBe(false);
  });
});
