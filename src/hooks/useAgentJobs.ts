import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { AgentJobListItem } from "@/lib/agent-jobs/list-item";

type AgentJobsPage = {
  items: AgentJobListItem[];
  nextBefore: string | null;
};

async function fetchAgentJobs(includeSucceeded: boolean, before?: string): Promise<AgentJobsPage> {
  const query = new URLSearchParams();
  if (includeSucceeded) query.set("includeSucceeded", "1");
  if (before) query.set("before", before);
  const suffix = query.toString();
  const res = await fetch(`/api/agent-jobs${suffix ? `?${suffix}` : ""}`);
  if (!res.ok) {
    throw new Error("Failed to fetch agent jobs");
  }
  const data = await res.json();
  return { items: data.items ?? [], nextBefore: data.nextBefore ?? null };
}

/**
 * 결재함 「봇 활동」 탭 데이터 훅 (Plan 2 Task 4).
 *
 * 기본은 성공 제외다 — 성공한 작업의 산출물은 조회 결과·기안 탭에 이미 있고, 이 탭이
 * 답하는 질문은 "봇이 무엇을 하다 막혔나"다. 「완료 포함」 토글이 `includeSucceeded`
 * 를 켜고, 그 값이 쿼리키에 들어가므로 두 목록은 서로 다른 캐시를 갖는다.
 */
export function useAgentJobs(includeSucceeded: boolean) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.agentJobs(includeSucceeded),
    queryFn: ({ pageParam }: { pageParam?: string }) => fetchAgentJobs(includeSucceeded, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: AgentJobsPage) => lastPage.nextBefore ?? undefined,
    refetchOnWindowFocus: true,
    staleTime: 15000,
  });

  // 진행 중인 「더 보기」가 있으면 다시 부르지 않는다 — 같은 커서로 두 번 부르면
  // 같은 페이지가 두 번 쌓인다(연타·엔터 반복이 실제로 그렇게 만든다).
  const loadMore = React.useCallback(() => {
    if (query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [query]);

  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    loadMore,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
  };
}
