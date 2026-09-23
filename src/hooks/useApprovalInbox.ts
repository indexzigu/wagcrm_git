import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { ApprovalInboxItem } from "@/components/crm/approvals/approval-cards";
import type {
  ActionProposalKind,
  ActionProposalStatus,
} from "@/repositories/actionProposalRepository";
import { useProposalActions } from "./useProposalActions";

type ApprovalInboxResponse = {
  items: ApprovalInboxItem[];
  count: number;
  nextBefore: string | null;
};

async function fetchProposals(
  status: ActionProposalStatus,
  kind: ActionProposalKind,
  before?: string
): Promise<ApprovalInboxResponse> {
  const query = new URLSearchParams({ status, kind });
  if (before) query.set("before", before);
  const res = await fetch(`/api/action-proposals?${query.toString()}`);
  if (!res.ok) {
    throw new Error("Failed to fetch action proposals");
  }
  const data = await res.json();
  return { items: data.items ?? [], count: data.count ?? 0, nextBefore: data.nextBefore ?? null };
}

/**
 * 승인 대기함 데이터 훅 (청사진 §2 approval-cards.tsx[구 approval-inbox.tsx], G3 /
 * §6-1 v1.2 상태 탭 파라미터화).
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
export function useApprovalInbox(
  status: ActionProposalStatus = "PENDING_APPROVAL",
  kind: ActionProposalKind = "WRITE"
) {
  // 이어 받기(before 커서) 조회다 — 목록 API 는 한 장에 50건만 주므로 그 이전 기안은
  // 「더 보기」로 받는다. 사이드바·탭 배지도 이 훅을 거치므로 캐시 모양이 한 가지로
  // 유지된다(배지는 첫 장만 받는다). 30초 폴링은 받아 둔 장을 전부 다시 받아 장 경계를
  // 새로 계산하므로, 새 기안이 앞에 끼어도 중복·누락이 생기지 않는다.
  const query = useInfiniteQuery({
    queryKey: queryKeys.actionProposals(status, kind),
    queryFn: ({ pageParam }: { pageParam?: string }) => fetchProposals(status, kind, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: ApprovalInboxResponse) => lastPage.nextBefore ?? undefined,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    staleTime: 15000,
  });

  const { approve, reject } = useProposalActions();

  // 진행 중인 「더 보기」가 있으면 다시 부르지 않는다 — 같은 커서로 두 번 부르면
  // 같은 장이 두 번 쌓인다(useReadRecords 와 같은 방어).
  const loadMore = React.useCallback(() => {
    if (query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [query]);

  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    // count 는 장 크기가 아니라 조건 전체 건수다(라우트 계약) — 첫 장 값을 쓴다.
    count: query.data?.pages[0]?.count ?? 0,
    loadMore,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    // 결재함 허브(/approvals)가 「목록을 불러오지 못했습니다.」 + 다시 불러오기 버튼을
    // 그리려면 실패를 구분해야 한다 — 빈 목록과 실패가 같은 얼굴이면 운영자가 "없다"로 읽는다.
    isError: query.isError,
    approve,
    reject,
    refetch: query.refetch,
  };
}
