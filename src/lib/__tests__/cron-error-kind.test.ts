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
    ["대상 503건 처리 실패", undefined, "unknown"],
    ["주문 401건 누락", undefined, "unknown"],
    ["ORD-503-1 실패", undefined, "unknown"],
    ["v4.0.403", undefined, "unknown"],
    ["429건 중 일부 실패", undefined, "unknown"],
    ["HTTP 503", undefined, "upstream_5xx"],
    ["status 401 Unauthorized", undefined, "auth"],
    ["429 Too Many Requests", undefined, "rate_limit"],
    ["Request failed with status code 502", undefined, "upstream_5xx"],
    ["fetch failed", 503, "upstream_5xx"],
    ["Request failed with status 503.", undefined, "upstream_5xx"],
    ["upstream returned 401.", undefined, "auth"],
    ["오류503 발생", undefined, "unknown"],
    ["N번째401 실패", undefined, "unknown"],
    // 세금계산서 메일함 실패는 HTTP 502 로 돌아온다 — 설정 누락·인증 실패 문구가 상태코드보다 먼저 걸려야
    // 자동 재시도·「외부 서비스 상태 확인」 오안내가 안 난다(⚙️K4).
    ["메일함 조회 실패: 메일 서버(IMAP) 연동 정보가 설정되어 있지 않습니다.", 502, "config"],
    ["메일함 조회 실패: Invalid credentials (Failure)", 502, "auth"],
    ["메일함 조회 실패: [AUTHENTICATIONFAILED] Invalid credentials", 502, "auth"],
    ["메일함 조회 실패: authentication failed", 502, "auth"],
    ["Authentication failed", undefined, "auth"],
    ["메일함 조회 실패: Connection closed", 502, "upstream_5xx"],
    // 4단계 보강 — 실제 기록 문구에 맞춘다.
    ["인스타 토큰 갱신 실패: Error validating access token (code 190)", undefined, "auth"],
    // 「토큰 교환 실패」만으로는 인증이 아니다 — 교환 서버 장애(503)는 일시 장애로 남아야 한다.
    ["토큰 교환 실패: HTTP 503", undefined, "upstream_5xx"],
    ["토큰 교환 실패: Error validating access token (code 190)", undefined, "auth"],
    ["(code 1900) something", undefined, "unknown"],
    // DB 인증 실패는 사람 손 문제가 아니라 설정 불일치 — 인증 규칙의 「authentication failed」보다 먼저 걸린다.
    ["Authentication failed against database server at 127.0.0.1, the provided database credentials are not valid", undefined, "config"],
    ["Authentication failed against database server", 401, "config"],
    ["GEMINI_API_KEY 가 설정되지 않았습니다", undefined, "config"],
    ["메일 계정이 설정돼 있지 않습니다", 502, "config"],
    // 네이버 429 는 여전히 한도(일시 장애 아님) — 넓히지 않는다.
    ["네이버 API status=429 Too Many Requests", undefined, "rate_limit"],
    ["fetch failed", 429, "rate_limit"],
  ];
  it.each(cases)("%s → %s", (text, status, kind) => {
    expect(classifyCronError(text, status)).toBe(kind);
  });

  it("app_down 은 돌려주지 않는다", () => {
    for (const [text, status] of cases) {
      expect(classifyCronError(text, status)).not.toBe("app_down");
    }
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
