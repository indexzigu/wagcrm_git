import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyCronAuth, verifyCronQuerySecret } from "@/lib/cron-auth";

/**
 * 크론 인증의 **동작** 계약. 구조(사본 금지·면제 라우트 가드 유무)는
 * `api-route-auth-coverage.contract.test.ts` 소관이고, 여기서는 "무엇이 통과하고
 * 무엇이 막히는가"만 고정한다.
 *
 * 핵심은 **fail-closed**: 종전 사본 2건이 `CRON_SECRET` 미설정을 "인증 면제"로 해석해
 * 열려 있었고, 나머지 사본도 미설정 시 기대값이 문자열 `"Bearer undefined"` 라 그 리터럴로
 * 통과할 수 있었다. 두 회귀를 각각 테스트로 못박는다.
 */

const ORIGINAL = process.env.CRON_SECRET;
const SECRET = "test-cron-secret-value";

const headerReq = (auth?: string) =>
  new Request("https://example.test/api/cron/x", auth ? { headers: { authorization: auth } } : {});

const queryReq = (secret?: string) =>
  new Request(
    `https://example.test/api/cron/apify-webhook/youtube${secret === undefined ? "" : `?secret=${encodeURIComponent(secret)}`}`,
  );

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("verifyCronAuth — 헤더형", () => {
  describe("CRON_SECRET 이 설정된 정상 구성", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = SECRET;
    });

    it("정확한 Bearer 헤더는 통과한다(양성 대조군)", () => {
      expect(verifyCronAuth(headerReq(`Bearer ${SECRET}`))).toBe(true);
    });

    it("헤더가 없으면 막는다", () => {
      expect(verifyCronAuth(headerReq())).toBe(false);
    });

    it("값이 틀리면 막는다", () => {
      expect(verifyCronAuth(headerReq("Bearer wrong-value-here"))).toBe(false);
    });

    it("길이가 다른 값도 던지지 않고 막는다(timingSafeEqual 길이 예외 방지)", () => {
      expect(() => verifyCronAuth(headerReq("Bearer x"))).not.toThrow();
      expect(verifyCronAuth(headerReq("Bearer x"))).toBe(false);
    });

    it("Bearer 접두사가 없으면 막는다", () => {
      expect(verifyCronAuth(headerReq(SECRET))).toBe(false);
    });
  });

  describe("CRON_SECRET 미설정 — fail-closed", () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it("헤더 없이 호출해도 열리지 않는다 (구 seller-metrics·sync-followers 회귀)", () => {
      expect(verifyCronAuth(headerReq())).toBe(false);
    });

    it('"Bearer undefined" 리터럴로도 통과하지 못한다 (구 사본 16건 회귀)', () => {
      expect(verifyCronAuth(headerReq("Bearer undefined"))).toBe(false);
    });

    it("빈 문자열 시크릿도 미설정과 같이 취급한다", () => {
      process.env.CRON_SECRET = "";
      expect(verifyCronAuth(headerReq("Bearer "))).toBe(false);
    });
  });
});

describe("verifyCronQuerySecret — 쿼리형(외부 웹훅 전용)", () => {
  it("정확한 secret 쿼리는 통과한다(양성 대조군)", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronQuerySecret(queryReq(SECRET))).toBe(true);
  });

  it("쿼리가 없으면 막는다", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronQuerySecret(queryReq())).toBe(false);
  });

  it("값이 틀리면 막는다", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronQuerySecret(queryReq("nope"))).toBe(false);
  });

  it("CRON_SECRET 미설정이면 무엇으로도 통과하지 못한다", () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronQuerySecret(queryReq())).toBe(false);
    expect(verifyCronQuerySecret(queryReq("undefined"))).toBe(false);
  });
});
