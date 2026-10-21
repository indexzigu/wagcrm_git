import { getCampaignAction } from "@/lib/campaign-actions";
import type { CampaignRow } from "@/lib/crm-types";

/**
 * 판매 관리 실행 보드의 빠른 필터 판정 — **이 파일이 유일한 정본이다.**
 * 보드의 버튼 건수·보드 필터링·판매 관리 머리 부제(「판매중 N건 · 지연 N건」)가 모두 이 술어를 읽는다.
 * 화면마다 같은 판정을 손으로 다시 적으면 두 숫자가 조용히 갈라진다(반복된 결함 유형).
 *
 * 중단(DROPPED)은 처리할 일이 없는 단계라 **건수에서 뺀다**. 보드는 중단 칸을 필터와 무관하게 늘 보여주므로
 * 그 예외는 보드가 소유한다(이 술어는 중단 행을 따로 다루지 않는다).
 */
export type ExecutionQuickFilter = "ALL" | "TODAY" | "DELAYED" | "MISSING_SALES" | "CHECKLIST_PENDING";

export const EXECUTION_QUICK_FILTERS: readonly ExecutionQuickFilter[] = [
  "ALL",
  "TODAY",
  "DELAYED",
  "MISSING_SALES",
  "CHECKLIST_PENDING",
];

export function matchesExecutionQuickFilter(
  campaign: CampaignRow,
  filter: ExecutionQuickFilter,
  now: Date = new Date(),
): boolean {
  switch (filter) {
    case "TODAY": {
      const action = getCampaignAction(campaign, now);
      return action.tone === "today" || action.tone === "overdue";
    }
    case "DELAYED": {
      const action = getCampaignAction(campaign, now);
      return action.isStagnant || action.tone === "overdue";
    }
    case "MISSING_SALES":
      return (
        (campaign.status === "ACTIVE" ||
          campaign.status === "CLOSED" ||
          campaign.status === "SETTLEMENT_WAIT") &&
        campaign.actualSales == null
      );
    case "CHECKLIST_PENDING":
      return Boolean(
        campaign.checklistSummary &&
          !campaign.checklistSummary.isComplete &&
          campaign.checklistSummary.requiredTotalCount > 0,
      );
    case "ALL":
    default:
      return true;
  }
}

/** 빠른 필터별 건수 — 중단 행 제외. */
export function countExecutionQuickFilters(
  rows: readonly CampaignRow[],
  now: Date = new Date(),
): Record<ExecutionQuickFilter, number> {
  const actionable = rows.filter((campaign) => campaign.status !== "DROPPED");
  const counts = {} as Record<ExecutionQuickFilter, number>;
  for (const filter of EXECUTION_QUICK_FILTERS) {
    counts[filter] = actionable.filter((campaign) => matchesExecutionQuickFilter(campaign, filter, now)).length;
  }
  return counts;
}
