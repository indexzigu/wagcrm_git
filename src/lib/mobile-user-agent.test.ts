import { describe, expect, it } from "vitest";
import { MOBILE_USER_AGENT_REGEX, isMobileUserAgent } from "./mobile-user-agent";

/**
 * UA 판정 SSOT 회귀 고정 — 이 정규식은 서버(/pipeline·/pipeline/tasks 의
 * mobileLite 판정)와 클라이언트(useIsMobile)가 공유한다. 판정이 어긋나면
 * 데스크톱 UI 가 빈 마스터데이터를 받는 사고가 되므로 대표 UA 를 못 박는다.
 */
describe("isMobileUserAgent", () => {
  it("모바일 UA(iPhone·iPad·Android)는 true", () => {
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("데스크톱 UA(macOS Chrome·Windows)는 false", () => {
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  it("빈값·null·undefined 는 false (헤더 부재 = 데스크톱 폴백)", () => {
    expect(isMobileUserAgent("")).toBe(false);
    expect(isMobileUserAgent(null)).toBe(false);
    expect(isMobileUserAgent(undefined)).toBe(false);
  });

  it("클라이언트 useIsMobile 과 같은 정규식을 노출한다(공유 계약)", () => {
    expect(MOBILE_USER_AGENT_REGEX.source).toBe(
      "Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini",
    );
    expect(MOBILE_USER_AGENT_REGEX.flags).toContain("i");
  });
});
