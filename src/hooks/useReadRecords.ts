import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { parseStoredJson } from "@/lib/stored-json";
import type { ApprovalInboxItem } from "@/components/crm/approvals/approval-cards";

/**
 * 결재함 「조회 결과」 탭 한 항목 (Plan 2 Task 4).
 *
 * 봇이 실행한 READ 기안(= EXECUTED + kind READ)이다. 목록 API 는 `payload` 만
 * 역직렬화하고 `structuredResult` 는 저장된 모양 그대로 돌려주므로(SQLite 는 문자열,
 * Postgres 는 객체 — `docs/agents/codebase-map.md` 의 Json 이원화 함정) 여기서
 * `parseStoredJson`(읽기 SSOT)을 통과시킨다. 캐스팅하면 로컬에서만 조용히 빈 값이 된다.
 */
export type ReadRecordItem = ApprovalInboxItem & {
  resultSummary: string | null;
  structuredResult: { operation?: string } | null;
};

type ReadRecordsPage = {
  items: ReadRecordItem[];
  count: number;
  nextBefore: string | null;
};

function normalize(raw: unknown): ReadRecordItem {
  const row = raw as ApprovalInboxItem & {
    resultSummary?: string | null;
    structuredResult?: unknown;
  };
  return {
    ...row,
    resultSummary: row.resultSummary ?? null,
    structuredResult: parseStoredJson<{ operation?: string }>(row.structuredResult),
  };
}

async function fetchReadRecords(before?: string): Promise<ReadRecordsPage> {
  const query = new URLSearchParams({ status: "EXECUTED", kind: "READ" });
  if (before) query.set("before", before);
  const res = await fetch(`/api/action-proposals?${query.toString()}`);
  if (!res.ok) {
    throw new Error("Failed to fetch read records");
  }
  const data = await res.json();
  return {
    items: (data.items ?? []).map(normalize),
    count: data.count ?? 0,
    nextBefore: data.nextBefore ?? null,
  };
}

/**
 * 봇 조회 결과 목록 훅. 조회 결과는 봇이 돌 때마다 쌓이므로 `before` 커서로
 * 이어 받는다(라우트가 페이지 크기 50 + `nextBefore` 를 준다).
 */
export function useReadRecords() {
  const query = useInfiniteQuery({
    queryKey: queryKeys.readRecords(),
    queryFn: ({ pageParam }: { pageParam?: string }) => fetchReadRecords(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: ReadRecordsPage) => lastPage.nextBefore ?? undefined,
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
    count: query.data?.pages[0]?.count ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    loadMore,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
  };
}
