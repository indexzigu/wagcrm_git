import { describe, it, expect } from "vitest";
import { KNOWN_JOBS, RETRY_DELAYS_SEC, retryDelaySecFor } from "@/lib/cron-jobs";

/**
 * 재시도 정책 계약 — 일시 장애로 실패한 자동 작업을 사람 없이 다시 돌릴지(설계 §5.4.1 확정판).
 *
 *  R1. 19개 작업 전부가 `retry` 키를 **명시적으로** 가진다. 타입이 필수로 강제하지만, 값 표를
 *      여기에 고정해 「안 함」 작업이 조용히 재시도 대상으로 바뀌는 것을 막는다 — 같은 부수효과가
 *      두 번 나는 사고(유료 실행 이중 시작 등)는 정책 한 칸 차이로 생긴다.
 *  R2. `retryDelaySecFor` 경계 — 일시 장애·정책 안·남은 회차일 때만 대기 초를 준다.
 */

const EXPECTED_POLICY: Record<string, { max: 1 | 2 } | "never"> = {
  "enrich-inbox": "never",
  "rehost-seller-media": { max: 2 },
  "naver-settlement-sync": "never",
  "naver-order-sync": { max: 1 },
  "enrich-references": { max: 1 },
  "collect-qnas": { max: 1 },
  "analyze-voc": { max: 1 },
  "price-monitoring": { max: 1 },
  "capture-stories": { max: 2 },
  "collect-campaign-posts": { max: 2 },
  "refresh-instagram-token": { max: 1 },
  "collect-instagram": { max: 1 },
  "collect-youtube": "never",
  "recampaign-auto-propose": { max: 1 },
  "tax-invoice-issue-confirm": { max: 1 },
  "scan-invoice-replies": "never",
  "db-exposure-audit": { max: 1 },
  "agent-auto-execute": "never",
  "encryption-key-audit": { max: 1 },
};

describe("KNOWN_JOBS 재시도 정책 계약", () => {
  it("R1: 모든 작업이 retry 를 명시적으로 갖고, 값이 정책 표와 같다", () => {
    expect(KNOWN_JOBS.length).toBe(19);
    const missing = KNOWN_JOBS.filter((job) => !Object.hasOwn(job, "retry")).map((job) => job.key);
    expect(missing).toEqual([]);
    const actual = Object.fromEntries(KNOWN_JOBS.map((job) => [job.key, job.retry]));
    expect(actual).toEqual(EXPECTED_POLICY);
  });

  it("대기 간격은 1회차 10분, 2회차 30분이다", () => {
    expect(RETRY_DELAYS_SEC).toEqual([600, 1800]);
  });
});

describe("retryDelaySecFor", () => {
  it("R2: 일시 장애 + 정책 1회 작업은 첫 실행 실패에만 10분을 준다", () => {
    expect(retryDelaySecFor("naver-order-sync", 1, "network")).toBe(600);
    expect(retryDelaySecFor("naver-order-sync", 2, "network")).toBeNull();
    expect(retryDelaySecFor("naver-order-sync", 3, "network")).toBeNull();
  });

  it("정책 2회 작업은 1회차 10분, 2회차 30분, 3회차는 없음", () => {
    expect(retryDelaySecFor("capture-stories", 1, "timeout")).toBe(600);
    expect(retryDelaySecFor("capture-stories", 2, "upstream_5xx")).toBe(1800);
    expect(retryDelaySecFor("capture-stories", 3, "network")).toBeNull();
  });

  it("앱 응답 없음(app_down)도 일시 장애로 본다", () => {
    expect(retryDelaySecFor("collect-instagram", 1, "app_down")).toBe(600);
  });

  it("사람이 손봐야 하는 종류(프록시 한도·인증·호출 한도·설정·원인 불명)는 재시도하지 않는다", () => {
    for (const kind of ["proxy_quota", "auth", "rate_limit", "config", "unknown"] as const) {
      expect(retryDelaySecFor("capture-stories", 1, kind), kind).toBeNull();
    }
  });

  it("「안 함」 작업과 목록에 없는 작업은 일시 장애여도 재시도하지 않는다", () => {
    expect(retryDelaySecFor("collect-youtube", 1, "network")).toBeNull();
    expect(retryDelaySecFor("agent-auto-execute", 1, "timeout")).toBeNull();
    expect(retryDelaySecFor("job-a", 1, "network")).toBeNull();
  });

  it("회차가 정수가 아니거나 1 미만이면 첫 실행(1)으로 본다", () => {
    expect(retryDelaySecFor("naver-order-sync", 0, "network")).toBe(600);
    expect(retryDelaySecFor("naver-order-sync", -5, "network")).toBe(600);
    expect(retryDelaySecFor("naver-order-sync", Number.NaN, "network")).toBe(600);
    expect(retryDelaySecFor("capture-stories", 1.5, "network")).toBe(600);
  });
});
