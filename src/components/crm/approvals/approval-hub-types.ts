import type { ApprovalInboxItem } from "./approval-cards";
import type { ReadRecordItem } from "@/hooks/useReadRecords";
import type { AgentJobListItem } from "@/lib/agent-jobs/list-item";
import type {
  ActionProposalKind,
  ActionProposalStatus,
} from "@/repositories/actionProposalRepository";

/**
 * 결재함 허브가 **실제로 쓰는 만큼만** 적은 훅 모양 (Plan 2 Task 4).
 *
 * `typeof useApprovalInbox` 로 묶지 않는 이유: 테스트가 주입하는 스텁이 실제 훅의
 * 모든 반환 필드(`nextBefore` 등)를 흉내 내야 해서, 훅에 필드가 하나 늘 때마다
 * 화면과 무관한 스텁이 함께 깨진다. 화면이 읽는 필드만 계약으로 고정하면 실제 훅은
 * 그 위에 자유롭게 더 돌려줄 수 있다(구조적 할당).
 */

export type ApprovalInboxHook = (
  status: ActionProposalStatus,
  kind?: ActionProposalKind
) => {
  items: ApprovalInboxItem[];
  count: number;
  isLoading: boolean;
  isError: boolean;
  approve: (id: string) => Promise<unknown>;
  reject: (id: string) => Promise<unknown>;
  refetch: () => unknown;
};

export type ReadRecordsHook = () => {
  items: ReadRecordItem[];
  count: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
  loadMore: () => unknown;
  /** 다음 장을 받아오는 중인가 — 「더 보기」 버튼의 비활성 근거. */
  isLoadingMore: boolean;
  hasMore: boolean;
};

export type AgentJobsHook = (includeSucceeded: boolean) => {
  items: AgentJobListItem[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
  loadMore: () => unknown;
  isLoadingMore: boolean;
  hasMore: boolean;
};

/** 허브에 주입할 수 있는 훅 묶음 — 기본값은 실제 훅이고, 테스트만 스텁을 넣는다. */
export type ApprovalHubHooks = {
  useApprovalInbox: ApprovalInboxHook;
  useReadRecords: ReadRecordsHook;
  useAgentJobs: AgentJobsHook;
  /** URL 의 `?tab=` 을 읽는다(기본 구현은 `useFilterParams`). */
  useTab: () => string | undefined;
};
