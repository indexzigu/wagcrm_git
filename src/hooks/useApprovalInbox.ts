import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { ApprovalInboxItem } from "@/components/crm/assistant/approval-inbox";
import type { ActionProposalStatus } from "@/repositories/actionProposalRepository";
import { useProposalActions } from "./useProposalActions";

type ApprovalInboxResponse = {
  items: ApprovalInboxItem[];
  count: number;
};

async function fetchProposals(status: ActionProposalStatus): Promise<ApprovalInboxResponse> {
  const res = await fetch(`/api/action-proposals?status=${status}`);
  if (!res.ok) {
    throw new Error("Failed to fetch action proposals");
  }
  const data = await res.json();
  return { items: data.items ?? [], count: data.count ?? 0 };
}

/**
 * 승인 대기함 데이터 훅 (청사진 §2 approval-inbox.tsx, G3 / §6-1 v1.2 상태 탭 파라미터화).
 * NotificationCenter/useNotifications와 동일한 폴링 패턴 — 목록 API가 이미 지원하는
 * ?status= 화이트리스트(VALID_STATUSES, route.ts)를 그대로 사용한다(백엔드 무변경).
 *
 * status 인자를 받아 쿼리키에 포함시킨다(queryKeys.actionProposals(status) — 기존
 * 구조 그대로, 상태별로 독립된 react-query 캐시를 갖는다). 기본값은 기존 동작과
 * 동일한 PENDING_APPROVAL — 무인자 호출부(사이드바 배지 등)는 하위호환된다.
 *
 * approve/reject는 공용 훅 useProposalActions로 추출됐다(청사진 §3-#3, M1 Promise 계약
 * 상속) — 동작은 이전과 동일하며, proposal-card.tsx도 동일한 훅을 사용한다. 이 훅의
 * invalidate는 프리픽스 기반("action-proposals")이라 재시도(승인) 후 실패 탭 캐시가
 * 사라지고 완료/대기 탭 캐시가 갱신되는 정합이 status 무관하게 성립한다.
 */
export function useApprovalInbox(status: ActionProposalStatus = "PENDING_APPROVAL") {
  const query = useQuery({
    queryKey: queryKeys.actionProposals(status),
    queryFn: () => fetchProposals(status),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    staleTime: 15000,
  });

  const { approve, reject } = useProposalActions();

  const items = query.data?.items ?? [];

  return {
    items,
    count: query.data?.count ?? 0,
    isLoading: query.isLoading,
    approve,
    reject,
    refetch: query.refetch,
  };
}
