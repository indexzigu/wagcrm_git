import { describe, it, expect } from "vitest";
import { ownerActionFor, shouldEscalate } from "@/lib/cron-incident-escalation";
import type { CronErrorKind } from "@/lib/cron-error-kind";
import type { IncidentKind } from "@/lib/cron-incident";

describe("shouldEscalate", () => {
  const cases: Array<[IncidentKind, CronErrorKind | null, number, boolean]> = [
    ["B", null, 1, true],
    ["A", "proxy_quota", 1, true],
    ["A", "auth", 1, true],
    ["A", "network", 1, false],
    ["A", "network", 2, true],
    ["A", "timeout", 1, false],
    ["A", "upstream_5xx", 3, true],
    ["A", "app_down", 1, false],
    ["A", "unknown", 1, true],
    ["A", null, 1, true],
  ];
  it.each(cases)("%s/%s %i회 → %s", (kind, errorKind, occurrences, expected) => {
    expect(shouldEscalate({ kind, errorKind, occurrences })).toBe(expected);
  });
});

describe("ownerActionFor", () => {
  const network = "같은 오류가 연속으로 났습니다. 외부 서비스 상태와 서버의 인터넷 연결을 확인해 주세요.";
  const fallback = "설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요.";
  const cases: Array<[IncidentKind, CronErrorKind | null, string]> = [
    ["B", null, "대상은 있는데 이틀 연속 결과가 0건입니다. 설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요."],
    ["A", "proxy_quota", "프록시 월 한도가 바닥난 것으로 보입니다. 프록시 계정을 더 등록하고 서버를 다시 시작해 주세요."],
    ["A", "auth", "인증이 거부됐습니다. 해당 서비스의 토큰이나 키가 만료됐는지 확인해 주세요."],
    ["A", "rate_limit", "호출 한도를 넘었습니다. 한도가 풀릴 때까지 기다리거나 사용량을 확인해 주세요."],
    ["A", "config", "설정값이 빠졌거나 데이터베이스에 연결하지 못했습니다. 운영 서버 설정을 확인해 주세요."],
    ["A", "network", network],
    ["A", "timeout", network],
    ["A", "upstream_5xx", network],
    ["A", "app_down", "서버가 응답하지 않아 작업이 시작되지 못했습니다. 서버가 켜져 있는지 확인해 주세요."],
    ["A", "unknown", fallback],
    ["A", null, fallback],
  ];
  it.each(cases)("%s/%s", (kind, errorKind, expected) => {
    expect(ownerActionFor({ kind, errorKind })).toBe(expected);
  });

  it("B 는 errorKind 가 있어도 산출 없음 문구다", () => {
    expect(ownerActionFor({ kind: "B", errorKind: "network" })).toMatch(/^대상은 있는데/);
  });

  it("문구에 긴 줄표·영문 코드가 없다", () => {
    for (const [kind, errorKind] of cases) {
      const s = ownerActionFor({ kind, errorKind });
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/[A-Za-z]/);
    }
  });
});
