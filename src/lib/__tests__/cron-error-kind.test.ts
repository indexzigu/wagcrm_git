import { describe, expect, it } from "vitest";
import {
  classifyCronError,
  isTransientErrorKind,
  type CronErrorKind,
} from "../cron-error-kind";

describe("classifyCronError", () => {
  const cases: Array<[string, number | undefined, CronErrorKind]> = [
    ["fetch failed <- Proxy response (407) !== 200 when HTTP Tunneling", undefined, "proxy_quota"],
    ["fetch failed <- connect ECONNRESET 1.2.3.4:443", undefined, "network"],
    ["HTTP 503", 503, "upstream_5xx"],
    ["The operation was aborted due to timeout", undefined, "timeout"],
    ['Error validating access token: Session has expired {"code":190}', undefined, "auth"],
    ["429 RESOURCE_EXHAUSTED spend cap", undefined, "rate_limit"],
    ["Can't reach database server at 127.0.0.1:55432", undefined, "config"],
    ["인스타 토큰/계정ID 미설정", undefined, "config"],
    ["스토리 응답 미포착(감시 패턴 불일치)", undefined, "unknown"],
  ];
  it.each(cases)("%s → %s", (text, status, kind) => {
    expect(classifyCronError(text, status)).toBe(kind);
  });

  it("일시 장애 종류만 재시도 대상이다", () => {
    expect(
      ["network", "timeout", "upstream_5xx", "app_down"].every((k) =>
        isTransientErrorKind(k as CronErrorKind),
      ),
    ).toBe(true);
    expect(
      ["proxy_quota", "auth", "rate_limit", "config", "unknown"].some((k) =>
        isTransientErrorKind(k as CronErrorKind),
      ),
    ).toBe(false);
  });
});
