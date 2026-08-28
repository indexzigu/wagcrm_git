import { describe, it, expect } from "vitest";
import {
  computeRecampaignAlerts,
  RECAMPAIGN_MIN_INTERVAL_DAYS,
  type RecampaignCampaignInput,
} from "../recampaign-timing";

const REF = new Date("2026-07-07T00:00:00.000Z");

function campaign(
  overrides: Partial<RecampaignCampaignInput> & { startDate: string }
): RecampaignCampaignInput {
  const start = new Date(overrides.startDate);
  return {
    sellerId: "s1",
    sellerName: "김본명",
    sellerAlias: null,
    status: "COMPLETED",
    endDate: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
    availabilityNote: null,
    ...overrides,
  };
}

describe("computeRecampaignAlerts", () => {
  it("월 케이던스 셀러의 적기 경과를 DUE로 감지한다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-03-01T00:00:00.000Z" }),
        campaign({ startDate: "2026-04-01T00:00:00.000Z" }),
        campaign({ startDate: "2026-05-01T00:00:00.000Z" }),
      ],
      REF
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].state).toBe("DUE");
    expect(alerts[0].medianIntervalDays).toBe(31);
    expect(alerts[0].runCount).toBe(3);
    // 마지막 시작 5/1 + 31일 = 6/1 → 7/7 기준 36일 경과
    expect(alerts[0].daysUntilDue).toBe(-36);
  });

  it("적기 14일 이내 임박은 UPCOMING으로 분류한다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-05-10T00:00:00.000Z" }),
        campaign({ startDate: "2026-06-10T00:00:00.000Z" }),
      ],
      REF
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].state).toBe("UPCOMING");
    expect(alerts[0].daysUntilDue).toBe(4);
  });

  it("진행·예정 캠페인이 있는 셀러는 제외한다 (이미 인게이지)", () => {
    const engaged = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-03-01T00:00:00.000Z" }),
        campaign({ startDate: "2026-04-01T00:00:00.000Z" }),
        campaign({ startDate: "2026-07-01T00:00:00.000Z", status: "PROPOSAL" }),
      ],
      REF
    );
    expect(engaged).toHaveLength(0);

    const ongoing = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-03-01T00:00:00.000Z" }),
        campaign({
          startDate: "2026-07-01T00:00:00.000Z",
          endDate: "2026-07-10T00:00:00.000Z",
          status: "CLOSED",
        }),
      ],
      REF
    );
    expect(ongoing).toHaveLength(0);
  });

  it("실행 캠페인 2개 미만이면 케이던스를 추정하지 않는다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-05-01T00:00:00.000Z" }),
        campaign({ startDate: "2026-06-01T00:00:00.000Z", status: "PREPARATION", endDate: "2026-06-02T00:00:00.000Z" }),
      ],
      REF
    );
    expect(alerts).toHaveLength(0);
  });

  it("같은 날 중복 행(임포트 산출물)은 간격 표본에서 제외하고 하한을 지킨다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-06-25T00:00:00.000Z" }),
        campaign({ startDate: "2026-06-25T00:00:00.000Z" }),
        campaign({ startDate: "2026-06-28T00:00:00.000Z" }),
      ],
      REF
    );
    expect(alerts).toHaveLength(1);
    // 유효 간격 3일 → 하한 7일로 클램프
    expect(alerts[0].medianIntervalDays).toBe(RECAMPAIGN_MIN_INTERVAL_DAYS);
    expect(alerts[0].state).toBe("DUE");
  });

  it("alias가 있으면 표시명으로 우선한다 + 가용 일정 전달", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-04-01T00:00:00.000Z" }),
        campaign({
          startDate: "2026-05-01T00:00:00.000Z",
          sellerAlias: "와이그라운드",
          availabilityNote: "9월까지 출산휴가",
        }),
      ],
      REF
    );
    expect(alerts[0].sellerName).toBe("와이그라운드");
    expect(alerts[0].availabilityNote).toBe("9월까지 출산휴가");
  });

  it("적기까지 14일 초과 남은 셀러는 알림하지 않는다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ startDate: "2026-05-07T00:00:00.000Z" }),
        campaign({ startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-07-05T00:00:00.000Z" }),
      ],
      REF
    );
    // 케이던스 55일 → 다음 적기 8/25, 49일 남음 → 제외
    expect(alerts).toHaveLength(0);
  });

  it("DUE(오래 경과 순) → UPCOMING(임박 순)으로 정렬한다", () => {
    const alerts = computeRecampaignAlerts(
      [
        campaign({ sellerId: "a", sellerName: "A", startDate: "2026-05-10T00:00:00.000Z" }),
        campaign({ sellerId: "a", sellerName: "A", startDate: "2026-06-10T00:00:00.000Z" }),
        campaign({ sellerId: "b", sellerName: "B", startDate: "2026-03-01T00:00:00.000Z" }),
        campaign({ sellerId: "b", sellerName: "B", startDate: "2026-04-01T00:00:00.000Z" }),
      ],
      REF
    );
    expect(alerts.map((a) => a.sellerId)).toEqual(["b", "a"]);
    expect(alerts[0].state).toBe("DUE");
    expect(alerts[1].state).toBe("UPCOMING");
  });
});
