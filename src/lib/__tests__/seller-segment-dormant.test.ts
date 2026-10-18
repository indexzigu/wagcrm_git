// 「휴면」 보기(오너 결정 2026-10-18) — 재계약 검토 대상만. 판정은 seller-dormancy.ts SSOT 를 그대로 탄다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SellerSummary } from "@/lib/crm-types";
import { DORMANT_DAYS, EXCLUDE_DAYS, computeDormancyTier } from "@/lib/seller-dormancy";
import {
  compareByLongestDormancy,
  filterSellersBySegment,
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

  it("판정은 computeDormancyTier 와 한 행도 어긋나지 않는다", () => {
    for (const row of rows) {
      const ssot =
        row.runCount !== undefined && computeDormancyTier(row.lastRunStartAt ?? null, NOW).tier === "DORMANT";
      expect(matchesSellerSegment(row, "dormant", NOW)).toBe(ssot);
    }
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
});
