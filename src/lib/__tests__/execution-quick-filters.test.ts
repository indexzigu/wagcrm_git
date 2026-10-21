import { describe, expect, it } from "vitest";
import type { CampaignRow } from "@/lib/crm-types";
import {
  countExecutionQuickFilters,
  matchesExecutionQuickFilter,
} from "@/lib/execution-quick-filters";

/**
 * 판매 관리 빠른 필터의 판정은 한 곳(`execution-quick-filters`)에만 산다 — 보드의 버튼 건수·
 * 보드 필터링·머리 부제(「판매중 N건 · 지연 N건」)가 같은 판정을 읽는다.
 * 중단(DROPPED)은 건수에서 빠진다(처리할 일이 없는 단계).
 */

const NOW = new Date(2026, 7, 20, 12);
const UPDATED = NOW.toISOString();

function row(id: string, over: Partial<CampaignRow>): CampaignRow {
  return {
    id,
    status: "ACTIVE",
    startDate: "2026-08-01",
    endDate: "2026-08-25",
    updatedAt: UPDATED,
    actualSales: 1000,
    checklistSummary: null,
    ...over,
  } as unknown as CampaignRow;
}

const ROWS: CampaignRow[] = [
  // 판매마감 기한(종료일) 지남 → 지연·오늘 처리, 실매출 없음
  row("overdue", { endDate: "2026-08-10", actualSales: null }),
  // 기한 전
  row("upcoming", {}),
  // 오늘이 기한 → 오늘 처리만(지연 아님), 실매출 0 은 입력된 값
  row("today", { endDate: "2026-08-20", actualSales: 0 }),
  // 준비 단계 · 필수 체크리스트 미완료
  row("prep", {
    status: "PREPARATION",
    startDate: "2026-09-01",
    checklistSummary: { isComplete: false, requiredTotalCount: 2 } as CampaignRow["checklistSummary"],
  }),
  // 중단 — 어떤 건수에도 들지 않는다
  row("dropped", {
    status: "DROPPED",
    endDate: "2026-08-01",
    actualSales: null,
    checklistSummary: { isComplete: false, requiredTotalCount: 2 } as CampaignRow["checklistSummary"],
  }),
];

describe("execution-quick-filters", () => {
  it("빠른 필터 건수 — 중단 제외", () => {
    expect(countExecutionQuickFilters(ROWS, NOW)).toEqual({
      ALL: 4,
      TODAY: 2,
      DELAYED: 1,
      MISSING_SALES: 1,
      CHECKLIST_PENDING: 1,
    });
  });

  it("행 판정은 건수와 같은 술어다", () => {
    const delayed = ROWS.filter(
      (r) => r.status !== "DROPPED" && matchesExecutionQuickFilter(r, "DELAYED", NOW),
    ).map((r) => r.id);
    expect(delayed).toEqual(["overdue"]);
    expect(matchesExecutionQuickFilter(ROWS[1], "ALL", NOW)).toBe(true);
  });
});
