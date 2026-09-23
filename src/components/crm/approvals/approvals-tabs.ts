import type {
  ActionProposalKind,
  ActionProposalStatus,
} from "@/repositories/actionProposalRepository";

/**
 * 결재함(/approvals) 탭 정의 SSOT (Plan 2 Task 4).
 *
 * 탭바·본문·빈 상태 문구가 같은 목록에서 파생된다 — 세 곳이 각자 탭을 열거하면
 * 탭 하나를 더할 때 한 곳이 빠지고, 그 빠짐은 조용하다(화면에서만 보인다).
 *
 * 세그먼트 둘은 운영자가 하는 일이 다르다: 「기안」은 결재(승인/반려/재시도)하는
 * 것이고, 「기록」은 읽기만 하는 것이다. 그래서 한 줄 안에서 구분선으로 나눈다.
 */
export type ApprovalsTab = "pending" | "executed" | "failed" | "rejected" | "reads" | "activity";

export type ApprovalsTabDef = {
  id: ApprovalsTab;
  label: string;
  segment: "기안" | "기록";
  status?: ActionProposalStatus;
  kind?: ActionProposalKind;
  /** 배지를 다는 탭인가 — 「지금 내 손이 필요한가」를 묻는 두 탭(대기·실패)뿐이다. */
  countBadge: boolean;
};

export const APPROVALS_TABS: ReadonlyArray<ApprovalsTabDef> = [
  { id: "pending", label: "대기", segment: "기안", status: "PENDING_APPROVAL", kind: "WRITE", countBadge: true },
  { id: "executed", label: "완료", segment: "기안", status: "EXECUTED", kind: "WRITE", countBadge: false },
  { id: "failed", label: "실패", segment: "기안", status: "FAILED", kind: "WRITE", countBadge: true },
  { id: "rejected", label: "반려", segment: "기안", status: "REJECTED", kind: "WRITE", countBadge: false },
  { id: "reads", label: "조회 결과", segment: "기록", status: "EXECUTED", kind: "READ", countBadge: false },
  { id: "activity", label: "봇 활동", segment: "기록", countBadge: false },
];

export const DEFAULT_TAB: ApprovalsTab = "pending";

/** 알 수 없는 값(손으로 고친 URL·낡은 북마크)은 조용히 기본 탭으로 접는다. */
export function parseTab(raw: string | undefined | null): ApprovalsTab {
  return APPROVALS_TABS.some((tab) => tab.id === raw) ? (raw as ApprovalsTab) : DEFAULT_TAB;
}

export function getTabDef(tab: ApprovalsTab): ApprovalsTabDef {
  return APPROVALS_TABS.find((def) => def.id === tab) ?? APPROVALS_TABS[0];
}

export const EMPTY_MESSAGES: Record<ApprovalsTab, string> = {
  pending: "승인할 기안이 없습니다.",
  executed: "실행한 기안이 없습니다.",
  failed: "실패한 기안이 없습니다.",
  rejected: "반려한 기안이 없습니다.",
  reads: "조회 결과가 없습니다. 슬랙에서 조회를 요청하면 여기에 쌓입니다.",
  activity: "봇 작업 기록이 없습니다.",
};

/**
 * 봇 작업(operation) 라벨. 화면에는 한글만 보이되, 표에 없는 값은 원문을 그대로
 * 보여준다 — 새 도구가 붙었을 때 「빈 칸」이 되면 무슨 일이 있었는지 알 수 없다.
 */
export const OPERATION_LABELS: Record<string, string> = {
  search_deals: "딜 검색",
  search_partners: "거래처 검색",
  get_pipeline_status: "파이프라인 현황",
  get_order_snapshot: "주문 스냅샷",
  get_campaign_financials: "캠페인 재무",
  get_settlement_report: "정산 리포트",
  create_action_proposal: "기안 올리기",
  get_action_proposal: "기안 조회",
};
