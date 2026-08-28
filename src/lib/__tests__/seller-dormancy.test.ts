// 휴면 티어 계약 테스트 — 90/180 경계 · 판정 불가 · 미래 캠페인 제외 · 그룹 접기.
//
// ⏰ **고정 날짜 픽스처를 쓰지 않는다**(P9 시한폭탄). 이 레포는 시각 기준 창을 고정
// 날짜로 테스트했다가 KST 날짜가 넘어가는 순간 main 이 하루 막힌 실사고가 있고,
// dev-qa 모듈이 "휴면 판정(90/180일)"을 같은 위험 지점으로 명시 등재해 뒀다.
// 전부 기준 시각 `now` 를 명시 주입하고 상대 오프셋으로 만든다.

import { describe, it, expect } from "vitest";
import {
  computeDormancyTier,
  tallySellerRuns,
  DORMANT_DAYS,
  EXCLUDE_DAYS,
  DORMANCY_TIER_LABEL,
} from "../seller-dormancy";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-04T00:00:00.000Z"); // 주입 기준 시각 — 시스템 시각과 무관
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

describe("computeDormancyTier — D20 경계 (건강 <90 · 휴면 90~180 · 제외 180+)", () => {
  it("상수는 두 개뿐이고 D20 값이다", () => {
    expect(DORMANT_DAYS).toBe(90);
    expect(EXCLUDE_DAYS).toBe(180);
  });

  it("오늘 시작한 진행은 건강 · 경과 0일", () => {
    expect(computeDormancyTier(NOW, NOW)).toEqual({ tier: "HEALTHY", daysSinceLastRun: 0 });
  });

  it("89일 = 건강, 90일 = 휴면 (하한 경계)", () => {
    expect(computeDormancyTier(daysAgo(89), NOW).tier).toBe("HEALTHY");
    expect(computeDormancyTier(daysAgo(90), NOW).tier).toBe("DORMANT");
  });

  it("179일 = 휴면, 180일 = 제외 (상한 경계)", () => {
    expect(computeDormancyTier(daysAgo(179), NOW).tier).toBe("DORMANT");
    expect(computeDormancyTier(daysAgo(180), NOW).tier).toBe("EXCLUDED");
  });

  it("경과일을 함께 돌려준다", () => {
    expect(computeDormancyTier(daysAgo(201), NOW)).toEqual({
      tier: "EXCLUDED",
      daysSinceLastRun: 201,
    });
  });

  it("ISO 문자열도 Date 와 같게 판정한다", () => {
    expect(computeDormancyTier(daysAgo(120).toISOString(), NOW)).toEqual(
      computeDormancyTier(daysAgo(120), NOW),
    );
  });
});

describe("computeDormancyTier — 판정 불가는 0일이 아니다", () => {
  it.each([
    ["null (과거 진행 0건)", null],
    ["undefined", undefined],
    ["파싱 불가 문자열", "언젠가"],
  ])("%s → UNKNOWN · 경과 null", (_label, input) => {
    expect(computeDormancyTier(input as never, NOW)).toEqual({
      tier: "UNKNOWN",
      daysSinceLastRun: null,
    });
  });

  it("⚠️ 과거 진행 0건을 '건강'으로 흘리지 않는다 (seller-fit 이 고친 구 결함의 재발 방지)", () => {
    expect(computeDormancyTier(null, NOW).tier).not.toBe("HEALTHY");
  });

  it("미래 시작일은 마지막 진행이 아니다 — 경과 음수를 만들지 않는다", () => {
    const future = new Date(NOW.getTime() + 30 * DAY_MS);
    expect(computeDormancyTier(future, NOW)).toEqual({ tier: "UNKNOWN", daysSinceLastRun: null });
  });

  it("라벨은 네 티어 전부에 있다", () => {
    expect(Object.keys(DORMANCY_TIER_LABEL).sort()).toEqual([
      "DORMANT",
      "EXCLUDED",
      "HEALTHY",
      "UNKNOWN",
    ]);
  });
});

describe("tallySellerRuns — 그룹은 1회 진행으로 접는다", () => {
  it("그룹 버킷은 행 수와 무관하게 1회", () => {
    const signals = tallySellerRuns(
      [{ sellerId: "s1", groupId: "g1", rowCount: 4, lastStartAt: daysAgo(10) }],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(1);
  });

  it("미그룹 버킷은 행 수 그대로", () => {
    const signals = tallySellerRuns(
      [{ sellerId: "s1", groupId: null, rowCount: 3, lastStartAt: daysAgo(10) }],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(3);
  });

  it("혼합 — 그룹 2개 + 미그룹 2행 = 4회", () => {
    const signals = tallySellerRuns(
      [
        { sellerId: "s1", groupId: "g1", rowCount: 5, lastStartAt: daysAgo(300) },
        { sellerId: "s1", groupId: "g2", rowCount: 2, lastStartAt: daysAgo(200) },
        { sellerId: "s1", groupId: null, rowCount: 2, lastStartAt: daysAgo(100) },
      ],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(4);
  });

  it("셀러별로 분리 집계한다", () => {
    const signals = tallySellerRuns(
      [
        { sellerId: "s1", groupId: null, rowCount: 1, lastStartAt: daysAgo(5) },
        { sellerId: "s2", groupId: null, rowCount: 2, lastStartAt: daysAgo(400) },
      ],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(1);
    expect(signals.get("s2")?.runCount).toBe(2);
    expect(signals.size).toBe(2);
  });
});

describe("tallySellerRuns — 마지막 진행 시작일", () => {
  it("버킷 중 가장 늦은 과거 시작일을 고른다", () => {
    const signals = tallySellerRuns(
      [
        { sellerId: "s1", groupId: "g1", rowCount: 2, lastStartAt: daysAgo(300) },
        { sellerId: "s1", groupId: null, rowCount: 1, lastStartAt: daysAgo(120) },
      ],
      NOW,
    );
    expect(signals.get("s1")?.lastRunStartAt).toBe(daysAgo(120).toISOString());
    expect(computeDormancyTier(signals.get("s1")!.lastRunStartAt, NOW).tier).toBe("DORMANT");
  });

  it("미래 시작일은 마지막 진행으로 잡지 않는다 (횟수는 유지)", () => {
    const future = new Date(NOW.getTime() + 14 * DAY_MS);
    const signals = tallySellerRuns(
      [
        { sellerId: "s1", groupId: null, rowCount: 1, lastStartAt: daysAgo(200) },
        { sellerId: "s1", groupId: "g1", rowCount: 1, lastStartAt: future },
      ],
      NOW,
    );
    expect(signals.get("s1")?.lastRunStartAt).toBe(daysAgo(200).toISOString());
    expect(computeDormancyTier(signals.get("s1")!.lastRunStartAt, NOW).tier).toBe("EXCLUDED");
  });

  it("과거 진행이 하나도 없으면 lastRunStartAt 은 null → 판정 불가", () => {
    const signals = tallySellerRuns(
      [{ sellerId: "s1", groupId: null, rowCount: 1, lastStartAt: null }],
      NOW,
    );
    expect(signals.get("s1")?.lastRunStartAt).toBeNull();
    expect(computeDormancyTier(signals.get("s1")!.lastRunStartAt, NOW).tier).toBe("UNKNOWN");
  });

  it("집계에 없는 셀러는 항목 자체가 없다 (호출부가 '진행 0건'으로 읽는다)", () => {
    expect(tallySellerRuns([], NOW).get("s1")).toBeUndefined();
  });
});
