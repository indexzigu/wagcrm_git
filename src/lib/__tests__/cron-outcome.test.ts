import { describe, expect, it } from "vitest";
import { declareTotalFailure } from "@/lib/cron-outcome";

/**
 * 크론의 **실질 실패 선언** 공용 판정 — `withSystemTaskStatus` 의 `CronOutcomeBody` 계약에서
 * "이번 실행이 통째로 헛돌았는가"를 재는 자리다.
 *
 * 이 파일이 지키는 것은 경계 셋이고, 그중 **시도 0 = 정상**이 가장 중요하다 —
 * 산출량으로 판정하면 대상이 없던 조용한 날마다 빨강이 되어 습관화로 신호를 잃는다.
 */
describe("declareTotalFailure", () => {
  it("시도한 것이 전부 실패하면 실패로 선언한다", () => {
    const outcome = declareTotalFailure({
      attempted: 4,
      succeeded: 0,
      unit: "명",
      what: "인스타 지표 수집",
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.failureReason).toContain("4명");
    expect(outcome.failureReason).toContain("인스타 지표 수집");
  });

  it("하나라도 성공했으면 실패가 아니다(개별 항목 실패를 승격하지 않는다)", () => {
    const outcome = declareTotalFailure({
      attempted: 4,
      succeeded: 1,
      unit: "명",
      what: "인스타 지표 수집",
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.failureReason).toBeUndefined();
  });

  it("시도가 0이면 실패가 아니다(대상 없는 날 — 상시 빨강 방지)", () => {
    const outcome = declareTotalFailure({
      attempted: 0,
      succeeded: 0,
      unit: "건",
      what: "VOC 분석",
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.failureReason).toBeUndefined();
  });
});
