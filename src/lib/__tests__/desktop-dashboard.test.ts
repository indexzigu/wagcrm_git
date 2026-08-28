import { describe, expect, it } from "vitest";
import { allocateCampaignToMonth, buildUpcomingEvents, type UpcomingCampaign } from "../desktop-dashboard";

function makeCampaign(overrides: Partial<UpcomingCampaign>): UpcomingCampaign {
  return {
    campaignName: null,
    // 브랜드몰(입금+지급) — 종전 픽스처의 암묵 채널. 자사몰 회귀는 아래 별도 케이스.
    salesChannel: "BRAND_MALL",
    startDate: new Date("2026-07-15T00:00:00.000Z"),
    endDate: new Date("2026-07-20T00:00:00.000Z"),
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    // 완료일·플래그는 **필수**다(생산자 누락 방지) — 픽스처도 값을 명시한다.
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    groupId: null,
    group: null,
    deal: { dealName: "딜A" },
    seller: { name: "셀러1", alias: null },
    ...overrides,
  };
}

/** 그룹 롤업 픽스처 — 완료일·플래그가 필수라 기본값을 여기서 채운다. */
function makeRollup(
  over: Partial<NonNullable<UpcomingCampaign["group"]>> = {},
): NonNullable<UpcomingCampaign["group"]> {
  return {
    name: null,
    startDate: null,
    endDate: null,
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...over,
  };
}

describe("allocateCampaignToMonth", () => {
  it("allocates a cross-month campaign by the operating days inside each month", () => {
    const campaign = {
      startDate: new Date("2026-05-28T00:00:00.000Z"),
      endDate: new Date("2026-06-06T00:00:00.000Z"),
    };

    expect(allocateCampaignToMonth(campaign, "2026-05")).toEqual({
      operatingDays: 4,
      weightedCampaignCount: 0.4,
    });
    expect(allocateCampaignToMonth(campaign, "2026-06")).toEqual({
      operatingDays: 6,
      weightedCampaignCount: 0.6,
    });
  });

  it("returns zero outside the campaign schedule", () => {
    expect(
      allocateCampaignToMonth(
        {
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-03T00:00:00.000Z"),
        },
        "2026-06",
      ),
    ).toEqual({ operatingDays: 0, weightedCampaignCount: 0 });
  });
});

describe("buildUpcomingEvents", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const scheduleEnd = new Date("2026-07-28T00:00:00.000Z");
  const startsOf = (events: { date: string; type: string; label: string }[]) =>
    events.filter((e) => e.type === "캠페인 시작");

  it("collapses grouped campaigns into a single entry using the group rollup", () => {
    const rollup = makeRollup({
      name: "그룹딜 외 1건",
      startDate: new Date("2026-07-15T00:00:00.000Z"),
      endDate: new Date("2026-07-20T00:00:00.000Z"),
    });
    const members = [
      makeCampaign({ groupId: "g1", group: rollup }),
      makeCampaign({ groupId: "g1", group: rollup, startDate: new Date("2026-07-16T00:00:00.000Z") }),
    ];
    const startEvents = startsOf(buildUpcomingEvents(members, now, scheduleEnd));
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].label).toBe("그룹딜 외 1건");
    expect(startEvents[0].date).toBe(new Date("2026-07-15T00:00:00.000Z").toISOString());
  });

  it("falls back to member min/max dates when the group rollup is empty", () => {
    const emptyRollup = makeRollup();
    const members = [
      makeCampaign({ groupId: "g2", group: emptyRollup, startDate: new Date("2026-07-18T00:00:00.000Z") }),
      makeCampaign({ groupId: "g2", group: emptyRollup, startDate: new Date("2026-07-16T00:00:00.000Z") }),
    ];
    const startEvents = startsOf(buildUpcomingEvents(members, now, scheduleEnd));
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].date).toBe(new Date("2026-07-16T00:00:00.000Z").toISOString());
    expect(startEvents[0].label).toBe("딜A - 셀러1 외 1건");
  });

  it("keeps ungrouped campaigns as separate entries", () => {
    const campaigns = [
      makeCampaign({ deal: { dealName: "딜A" } }),
      makeCampaign({ deal: { dealName: "딜B" } }),
    ];
    expect(startsOf(buildUpcomingEvents(campaigns, now, scheduleEnd))).toHaveLength(2);
  });
});

/**
 * 「다가올 14일 일정」의 대금 이벤트는 채널 슬롯에서 파생한다(2026-08-25 2단계).
 * 종전에는 `"입금 예정"`/`"지급 예정"` 두 줄이 하드코딩돼 있어 자사몰의 공급사 지급
 * 예정일이 타임라인에 **아예 뜨지 않았다**.
 */
describe("buildUpcomingEvents — 대금 이벤트는 채널 슬롯에서 파생한다", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const scheduleEnd = new Date("2026-07-28T00:00:00.000Z");
  const moneyTypes = (events: ReturnType<typeof buildUpcomingEvents>) =>
    events.filter((e) => e.type.includes("예정")).map((e) => e.type);

  it("브랜드몰: 입금(공급사) + 지급(셀러) 두 줄에 상대를 병기한다", () => {
    const events = buildUpcomingEvents(
      [
        makeCampaign({
          salesChannel: "BRAND_MALL",
          expectedDepositDate: new Date("2026-07-16T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-07-18T00:00:00.000Z"),
        }),
      ],
      now,
      scheduleEnd,
    );
    expect(moneyTypes(events)).toEqual(["입금 예정 (공급사)", "지급 예정 (셀러)"]);
  });

  it("자사몰: 지급(공급사) + 지급(셀러)이고 입금 줄이 없다", () => {
    const events = buildUpcomingEvents(
      [
        makeCampaign({
          salesChannel: "OWN_MALL_NAVER",
          // 레거시 입금 예정일이 남아 있어도 칸이 없으므로 이벤트가 되지 않는다.
          expectedDepositDate: new Date("2026-07-15T00:00:00.000Z"),
          expectedSupplierPayoutDate: new Date("2026-07-16T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-07-18T00:00:00.000Z"),
        }),
      ],
      now,
      scheduleEnd,
    );
    expect(moneyTypes(events)).toEqual(["지급 예정 (공급사)", "지급 예정 (셀러)"]);
  });

  it("자사몰 그룹: 그룹 스칼라가 null이면 멤버 공급사 예정일 최솟값으로 폴백한다", () => {
    const rollup = makeRollup({ name: "자사몰 그룹" });
    const events = buildUpcomingEvents(
      [
        makeCampaign({
          groupId: "g9",
          group: rollup,
          salesChannel: "OWN_MALL_NAVER",
          expectedSupplierPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
        }),
        makeCampaign({
          groupId: "g9",
          group: rollup,
          salesChannel: "OWN_MALL_NAVER",
          expectedSupplierPayoutDate: new Date("2026-07-17T00:00:00.000Z"),
        }),
      ],
      now,
      scheduleEnd,
    );
    const supplier = events.filter((e) => e.type === "지급 예정 (공급사)");
    expect(supplier).toHaveLength(1);
    expect(supplier[0].date).toBe(new Date("2026-07-17T00:00:00.000Z").toISOString());
  });
});

describe("buildUpcomingEvents — 완료된 대금은 예정으로 뜨지 않는다", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const scheduleEnd = new Date("2026-07-28T00:00:00.000Z");
  const moneyOf = (events: { date: string; type: string; label: string }[]) =>
    events.filter((e) => e.type.startsWith("지급") || e.type.startsWith("입금"));

  /**
   * 오너 지적 2026-07-15 — 이미 지급한 건이 예정일이 되면 「지급 예정」으로 다시 뜬다.
   * 판정은 캘린더와 같은 SSOT(`resolveMoneySlotEffectiveDate`)를 쓴다.
   */
  it("이미 지급한 건은 예정일이 창 안이어도 「지급 예정」으로 뜨지 않는다", () => {
    const events = moneyOf(
      buildUpcomingEvents(
        [
          makeCampaign({
            expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
            payoutCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
            isPayoutCompleted: true,
          }),
        ],
        now,
        scheduleEnd,
      ),
    );
    expect(events).toHaveLength(0);
  });

  it("미완료 건은 종전대로 「지급 예정 (셀러)」로 뜬다", () => {
    const events = moneyOf(
      buildUpcomingEvents(
        [makeCampaign({ expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z") })],
        now,
        scheduleEnd,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("지급 예정 (셀러)");
  });

  it("완료일이 창 안이면 「지급 완료」로 그 날에 뜬다", () => {
    const events = moneyOf(
      buildUpcomingEvents(
        [
          makeCampaign({
            expectedPayoutDate: new Date("2026-07-16T00:00:00.000Z"),
            payoutCompletedAt: new Date("2026-07-18T00:00:00.000Z"),
            isPayoutCompleted: true,
          }),
        ],
        now,
        scheduleEnd,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("지급 완료 (셀러)");
    expect(events[0].date).toBe(new Date("2026-07-18T00:00:00.000Z").toISOString());
  });

  /**
   * 그룹 완료 플래그가 켜졌는데 **그룹 완료일이 비어 있는** 행 — 날짜를 멤버로 폴백하면
   * 멤버의 낡은 완료일이 「실제 지급일」로 둔갑한다(플래그는 그룹만 보는데 날짜만 관대해지는
   * 비대칭). 완료일은 플래그와 **같은 엄격도**로 읽는다.
   */
  it("그룹 완료일이 비어 있으면 멤버 완료일로 폴백하지 않는다", () => {
    const events = moneyOf(
      buildUpcomingEvents(
        [
          makeCampaign({
            groupId: "g2",
            group: makeRollup({
              name: "그룹딜",
              expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
              isPayoutCompleted: true,
            }),
            payoutCompletedAt: new Date("2026-07-16T00:00:00.000Z"),
            isPayoutCompleted: true,
          }),
        ],
        now,
        scheduleEnd,
      ),
    );
    // 완료일이 없으므로 예정일에 남는다(=「완료」로 부르지 않는다) — 멤버의 7/16 을 쓰지 않는다.
    expect(events).toHaveLength(1);
    expect(events[0].date).toBe(new Date("2026-07-20T00:00:00.000Z").toISOString());
    expect(events[0].type).toBe("지급 예정 (셀러)");
  });

  it("그룹은 그룹 완료일이 정본이다 — 멤버 잔존 완료일을 쓰지 않는다", () => {
    const rollup = makeRollup({
      name: "그룹딜",
      startDate: new Date("2026-07-15T00:00:00.000Z"),
      endDate: new Date("2026-07-20T00:00:00.000Z"),
      expectedPayoutDate: new Date("2026-07-16T00:00:00.000Z"),
      payoutCompletedAt: new Date("2026-07-18T00:00:00.000Z"),
      isPayoutCompleted: true,
    });
    const events = moneyOf(
      buildUpcomingEvents(
        [
          makeCampaign({
            groupId: "g1",
            group: rollup,
            payoutCompletedAt: new Date("2026-07-25T00:00:00.000Z"),
            isPayoutCompleted: true,
          }),
        ],
        now,
        scheduleEnd,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].date).toBe(new Date("2026-07-18T00:00:00.000Z").toISOString());
  });
});
