import { describe, it, expect } from "vitest";
import {
  computeScheduleGaps,
  foldBucketCampaigns,
  DEFAULT_SCHEDULE_THRESHOLDS,
} from "../schedule-gap-briefing";

/**
 * item 10 회귀 — 주 일부만 빈 구간이 확보 필요로 잡히는지 검증.
 * 구 주간 버킷 로직은 한 주에 하루라도 캠페인이 있으면 그 주 전체를 OK 로 삼켜
 * 7/18~7/20 같은 부분 구간을 놓쳤다. 일 단위 갭은 이를 정확히 잡는다.
 */
describe("computeScheduleGaps — 일 단위 빈 구간", () => {
  const now = new Date("2026-07-09T01:00:00.000Z");
  const rangeEnd = new Date("2026-08-02T00:00:00.000Z");

  it("otherwise-covered 주 안의 부분 빈 구간(7/18~7/20, 7/27~7/31)을 잡는다", () => {
    const campaigns = [
      { start: "2026-07-09", end: "2026-07-17" },
      { start: "2026-07-21", end: "2026-07-26" },
      { start: "2026-08-01", end: "2026-08-02" },
    ];

    const gaps = computeScheduleGaps(now, campaigns, rangeEnd, DEFAULT_SCHEDULE_THRESHOLDS);

    expect(gaps).toHaveLength(2);

    expect(gaps[0]).toMatchObject({
      label: "7/18~7/20",
      dayCount: 3,
      daysFromNow: 9,
      urgency: "DANGER",
    });
    expect(gaps[1]).toMatchObject({
      label: "7/27~7/31",
      dayCount: 5,
      daysFromNow: 18,
      urgency: "DANGER",
    });
  });

  it("하루짜리 빈 구간은 단일 날짜 라벨(M/D)로 표기한다", () => {
    const campaigns = [
      { start: "2026-07-09", end: "2026-07-17" },
      { start: "2026-07-19", end: "2026-08-02" }, // 7/18 하루만 빈다
    ];

    const gaps = computeScheduleGaps(now, campaigns, rangeEnd, DEFAULT_SCHEDULE_THRESHOLDS);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ label: "7/18", dayCount: 1 });
  });

  it("전 구간에 캠페인이 하루도 없으면 오늘부터 하나의 큰 갭", () => {
    const gaps = computeScheduleGaps(now, [], rangeEnd, DEFAULT_SCHEDULE_THRESHOLDS);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].startDate.slice(0, 10)).toBe("2026-07-09");
    expect(gaps[0].daysFromNow).toBe(0);
    expect(gaps[0].urgency).toBe("DANGER");
  });

  it("전 구간이 캠페인으로 덮이면 갭이 없다", () => {
    const campaigns = [{ start: "2026-07-01", end: "2026-08-31" }];
    const gaps = computeScheduleGaps(now, campaigns, rangeEnd, DEFAULT_SCHEDULE_THRESHOLDS);
    expect(gaps).toHaveLength(0);
  });
});

/**
 * 그룹캠페인 접기 회귀 — 그룹은 실캠페인 1개의 딜별 분할(CG-1)이므로, 커버리지
 * 버킷의 확정 건수·툴팁 목록은 그룹당 1건이어야 한다(멤버 행 수로 세면 부풀려짐).
 */
describe("foldBucketCampaigns — 그룹캠페인 1건 접기", () => {
  const seller = { name: "본명", alias: "가온" };
  const member = (id: string, groupId: string | null, dealName: string, groupName: string | null = null) => ({
    id,
    status: "CONFIRMED",
    groupId,
    group: groupId ? { name: groupName } : null,
    deal: { dealName },
    seller,
  });

  it("그룹 멤버 3건은 그룹명 라벨 1건으로 접히고, 미그룹은 개별 유지된다", () => {
    const folded = foldBucketCampaigns([
      member("m1", "g1", "비타민", "[가온] 비타민 외 2건"),
      member("s1", null, "콜라겐"),
      member("m2", "g1", "오메가3", "[가온] 비타민 외 2건"),
      member("m3", "g1", "유산균", "[가온] 비타민 외 2건"),
    ]);

    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ id: "m1", label: "[가온] 비타민 외 2건" });
    expect(folded[1]).toMatchObject({ id: "s1", label: "콜라겐 - 가온" });
  });

  it("그룹명이 없으면 첫 멤버 딜명 - 셀러(별칭 우선) 외 N-1건으로 합성한다", () => {
    const folded = foldBucketCampaigns([
      member("m1", "g1", "비타민"),
      member("m2", "g1", "오메가3"),
    ]);

    expect(folded).toEqual([{ id: "m1", label: "비타민 - 가온 외 1건", status: "CONFIRMED" }]);
  });

  it("버킷에 그룹 멤버가 1건만 걸리면 접미사 없이 표기한다", () => {
    const folded = foldBucketCampaigns([member("m1", "g1", "비타민")]);
    expect(folded).toEqual([{ id: "m1", label: "비타민 - 가온", status: "CONFIRMED" }]);
  });
});
