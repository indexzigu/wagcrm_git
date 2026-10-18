// 「휴면」 보기(오너 결정 2026-10-18) — 재계약 검토 대상만. 판정은 seller-dormancy.ts SSOT 를 그대로 탄다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SellerSummary } from "@/lib/crm-types";
import { DORMANT_DAYS, EXCLUDE_DAYS, computeDormancyTier } from "@/lib/seller-dormancy";
import {
  compareByLongestDormancy,
  filterSellersBySegment,
  isDormantForReview,
  matchesSellerSegment,
} from "@/lib/seller-segment";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function seller(id: string, over: Partial<SellerSummary> = {}): SellerSummary {
  return {
    id,
    name: id,
    snsType: "INSTAGRAM",
    snsHandle: id,
    currentFollowers: 0,
    campaignCount: 1,
    runCount: 1,
    lastRunStartAt: daysAgo(10),
    ...over,
  } as SellerSummary;
}

describe("seller-segment: dormant", () => {
  const rows = [
    seller("healthy", { lastRunStartAt: daysAgo(DORMANT_DAYS - 1) }),
    seller("edge90", { lastRunStartAt: daysAgo(DORMANT_DAYS) }),
    seller("d150", { lastRunStartAt: daysAgo(150) }),
    seller("edge179", { lastRunStartAt: daysAgo(EXCLUDE_DAYS - 1) }),
    seller("excluded", { lastRunStartAt: daysAgo(EXCLUDE_DAYS) }),
    seller("never", { runCount: 0, lastRunStartAt: null }),
    seller("future", { lastRunStartAt: new Date(NOW.getTime() + 86_400_000).toISOString() }),
    // 집계 실패(runCount 없음) — 표가 「—」로 그리는 행은 휴면으로 단정하지 않는다
    seller("unknownAgg", { runCount: undefined, lastRunStartAt: daysAgo(150) }),
  ];

  it("SSOT 가 DORMANT 로 판정한 셀러만 남긴다(경계 90 포함 · 180 은 제외 티어라 빠짐)", () => {
    const ids = filterSellersBySegment(rows, "dormant", NOW).map((s) => s.id);
    expect(ids).toEqual(["edge90", "d150", "edge179"]);
  });

  it("판정은 computeDormancyTier 와 한 행도 어긋나지 않는다(다가올·진행 중 캠페인이 없는 행)", () => {
    for (const row of rows) {
      const ssot =
        row.runCount !== undefined && computeDormancyTier(row.lastRunStartAt ?? null, NOW).tier === "DORMANT";
      expect(matchesSellerSegment(row, "dormant", NOW)).toBe(ssot);
    }
  });

  // ss-ux P1-2(2026-10-18): 마지막 진행이 오래됐어도 **시작예정** 캠페인이 잡혀 있으면 재계약 검토 대상이 아니다.
  // 신호는 셀러 목록의 「시작예정」 표시와 같은 것(`campaignRecency` — 서버 집계 우선, 없으면 캡 배열).
  describe("시작예정·진행중 캠페인이 있으면 휴면 보기에서 빠진다", () => {
    const old = { lastRunStartAt: daysAgo(150) };
    const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);

    it("서버 집계 신호(hasUpcomingCampaign)가 있으면 그것으로", () => {
      const s = seller("upcoming", { ...old, hasUpcomingCampaign: true, hasActiveCampaign: false, lastCampaignEndAt: daysAgo(140) });
      expect(computeDormancyTier(s.lastRunStartAt, NOW).tier).toBe("DORMANT"); // 티어 SSOT 는 그대로 휴면이다
      expect(matchesSellerSegment(s, "dormant", NOW)).toBe(false);
    });

    it("신호가 없으면(구 페이로드) 캠페인 배열의 미래 시작일로", () => {
      const s = seller("upcomingArr", {
        ...old,
        campaigns: [
          { id: "n", dealName: "d", brandName: null, startDate: inDays(5), endDate: inDays(12), status: "PLANNED" },
        ] as unknown as SellerSummary["campaigns"],
      });
      expect(matchesSellerSegment(s, "dormant", NOW)).toBe(false);
    });

    it("드랍된 미래 캠페인은 시작예정이 아니다 — 여전히 휴면", () => {
      const s = seller("droppedFuture", {
        ...old,
        campaigns: [
          { id: "x", dealName: "d", brandName: null, startDate: inDays(5), endDate: inDays(12), status: "DROPPED" },
        ] as unknown as SellerSummary["campaigns"],
      });
      expect(matchesSellerSegment(s, "dormant", NOW)).toBe(true);
    });

    it("isDormantForReview 가 필터와 한 행도 어긋나지 않는다 — 배지와 보기가 같은 판정을 쓴다", () => {
      const cases = [
        ...rows,
        seller("up", { ...old, hasUpcomingCampaign: true, hasActiveCampaign: false, lastCampaignEndAt: daysAgo(140) }),
        seller("past", { ...old, hasUpcomingCampaign: false, hasActiveCampaign: false, lastCampaignEndAt: daysAgo(140) }),
      ];
      for (const row of cases) expect(isDormantForReview(row, NOW)).toBe(matchesSellerSegment(row, "dormant", NOW));
    });

    it("지난 캠페인만 있으면 휴면 그대로", () => {
      const s = seller("pastOnly", { ...old, hasUpcomingCampaign: false, hasActiveCampaign: false, lastCampaignEndAt: daysAgo(140) });
      expect(matchesSellerSegment(s, "dormant", NOW)).toBe(true);
    });
  });

  it("오래 쉰 순으로 정렬한다(마지막 진행 시작일이 이른 셀러 먼저)", () => {
    const sorted = [...filterSellersBySegment(rows, "dormant", NOW)].sort(compareByLongestDormancy);
    expect(sorted.map((s) => s.id)).toEqual(["edge179", "d150", "edge90"]);
  });

  it("기존 세그먼트는 now 인자와 무관하다(회귀 방지)", () => {
    expect(filterSellersBySegment(rows, "active", NOW)).toHaveLength(rows.length);
    expect(filterSellersBySegment(rows, "prospect", NOW)).toHaveLength(0);
  });
});

describe("셀러 목록 보기 토글", () => {
  it("「휴면」 선택지가 붙어 있다(한 낱말)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components", "crm", "sellers-management.tsx"), "utf8");
    expect(src).toContain('{ value: "dormant", label: "휴면" }');
  });

  it("휴면 배지는 경과일을 글자로 함께 쓴다(「휴면 132일」) — title 에만 두지 않는다", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components", "crm", "sellers-management.tsx"), "utf8");
    expect(src).toContain("`${DORMANCY_TIER_LABEL.DORMANT} ${verdict.daysSinceLastRun}일`");
  });
});
