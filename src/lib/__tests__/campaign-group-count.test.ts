import { describe, expect, it } from "vitest";
import {
  buildEffectiveCampaignPeriods,
  countEffectiveCampaigns,
  tallyEffectiveCampaignCounts,
} from "../campaign-group-count";
import { allocateCampaignToMonth } from "../desktop-dashboard";

describe("countEffectiveCampaigns", () => {
  it("counts a group as one campaign regardless of member count", () => {
    // 오너 시나리오 그대로: 그룹A(하위 3) + 캠페인B = 2건 (4건 아님)
    const items = [
      { groupId: "gA" },
      { groupId: "gA" },
      { groupId: "gA" },
      { groupId: null },
    ];
    expect(countEffectiveCampaigns(items)).toBe(2);
  });

  it("counts ungrouped rows individually and handles empty input", () => {
    expect(countEffectiveCampaigns([])).toBe(0);
    expect(countEffectiveCampaigns([{ groupId: null }, { groupId: null }])).toBe(2);
  });

  it("counts distinct groups separately", () => {
    const items = [{ groupId: "g1" }, { groupId: "g1" }, { groupId: "g2" }, { groupId: "g2" }];
    expect(countEffectiveCampaigns(items)).toBe(2);
  });

  it("preserves the 0/positive boundary used by seller segments (그룹은 멤버≥2라 0이 될 수 없음)", () => {
    // active(>0) / prospect(===0) 세그먼트 경계가 정의 전환으로 흔들리지 않는다
    expect(countEffectiveCampaigns([{ groupId: "g" }])).toBeGreaterThan(0);
  });
});

describe("buildEffectiveCampaignPeriods (G1: 그룹 = 멤버 포락선 1캠페인)", () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it("merges group members into one min-start ~ max-end envelope", () => {
    const periods = buildEffectiveCampaignPeriods([
      { groupId: "g1", startDate: d("2026-07-10"), endDate: d("2026-07-15") },
      { groupId: "g1", startDate: d("2026-07-05"), endDate: d("2026-07-12") },
      { groupId: null, startDate: d("2026-07-01"), endDate: d("2026-07-03") },
    ]);
    expect(periods).toHaveLength(2);
    expect(periods.find((p) => p.startDate.getTime() === d("2026-07-05").getTime())?.endDate).toEqual(
      d("2026-07-15"),
    );
  });

  it("keeps groups apart and does not mutate input campaigns", () => {
    const member = { groupId: "g1", startDate: d("2026-07-10"), endDate: d("2026-07-15") };
    const periods = buildEffectiveCampaignPeriods([
      member,
      { groupId: "g2", startDate: d("2026-08-01"), endDate: d("2026-08-05") },
    ]);
    expect(periods).toHaveLength(2);
    expect(member.startDate).toEqual(d("2026-07-10"));
  });

  it("weights a 3-member group as a single campaign in monthly allocation", () => {
    // 동일 기간 3멤버 그룹: 행 단위면 3.0건, 유효 기준이면 1.0건
    const members = [
      { groupId: "g1", startDate: d("2026-07-01"), endDate: d("2026-07-10") },
      { groupId: "g1", startDate: d("2026-07-01"), endDate: d("2026-07-10") },
      { groupId: "g1", startDate: d("2026-07-01"), endDate: d("2026-07-10") },
    ];
    const effective = buildEffectiveCampaignPeriods(members).reduce(
      (sum, p) => sum + allocateCampaignToMonth(p, "2026-07").weightedCampaignCount,
      0,
    );
    const raw = members.reduce(
      (sum, p) => sum + allocateCampaignToMonth(p, "2026-07").weightedCampaignCount,
      0,
    );
    expect(effective).toBe(1);
    expect(raw).toBe(3);
  });
});

describe("tallyEffectiveCampaignCounts (Prisma groupBy 접기)", () => {
  it("adds 1 per group bucket and rowCount for the ungrouped bucket", () => {
    const tally = tallyEffectiveCampaignCounts([
      { sellerId: "s1", groupId: "g1", rowCount: 3 },
      { sellerId: "s1", groupId: null, rowCount: 2 },
      { sellerId: "s2", groupId: null, rowCount: 5 },
    ]);
    expect(tally.get("s1")).toBe(3); // 그룹 1 + 미그룹 2
    expect(tally.get("s2")).toBe(5);
    expect(tally.get("s3")).toBeUndefined(); // 캠페인 없는 셀러는 행 자체가 없다
  });

  it("counts two groups of the same seller separately", () => {
    const tally = tallyEffectiveCampaignCounts([
      { sellerId: "s1", groupId: "g1", rowCount: 2 },
      { sellerId: "s1", groupId: "g2", rowCount: 4 },
    ]);
    expect(tally.get("s1")).toBe(2);
  });
});
