"use client";

import * as React from "react";
import {
  PendingCard,
  ExecutedCard,
  FailedCard,
  RejectedCard,
} from "./approval-cards";
import type { ApprovalInboxItem } from "./approval-cards";
import { ReadRecordCard } from "./read-record-card";
import { BotActivityTable, SucceededToggle } from "./bot-activity-table";
import { EMPTY_MESSAGES, getTabDef } from "./approvals-tabs";
import type { ApprovalsTab } from "./approvals-tabs";
import type { AgentJobsHook, ApprovalInboxHook, ReadRecordsHook } from "./approval-hub-types";
import {
  CardListSkeleton,
  EmptyState,
  LoadErrorState,
  LoadMoreButton,
  TableSkeleton,
} from "./hub-states";

/**
 * 결재함 본문 3종 (Plan 2 Task 4).
 *
 * 탭마다 **별도의 컴포넌트**인 것이 요점이다 — 데이터 훅을 그 탭이 화면에 있을 때만
 * 부르기 위해서다. 허브 한 곳에서 여섯 탭의 훅을 전부 부르면 보이지도 않는 탭 때문에
 * 매번 조회가 나간다(봇 활동은 admin 전용 목록이라 더 그렇다).
 */

function ProposalCard({
  tab,
  item,
  approve,
  reject,
}: {
  tab: ApprovalsTab;
  item: ApprovalInboxItem;
  approve: (id: string) => Promise<unknown>;
  reject: (id: string) => Promise<unknown>;
}) {
  switch (tab) {
    case "executed":
      return <ExecutedCard item={item} />;
    case "failed":
      // 실패 카드의 [재시도]는 승인과 같은 경로다(FAILED→APPROVED 재시도, Task 3).
      return <FailedCard item={item} onApprove={approve} />;
    case "rejected":
      return <RejectedCard item={item} />;
    default:
      return <PendingCard item={item} onApprove={approve} onReject={reject} />;
  }
}

/** 기안 4탭(대기·완료·실패·반려) — 상태만 다르고 골격은 같다. */
export function ProposalTabBody({
  tab,
  useApprovalInbox,
}: {
  tab: ApprovalsTab;
  useApprovalInbox: ApprovalInboxHook;
}) {
  const def = getTabDef(tab);
  const { items, isLoading, isError, refetch, approve, reject } = useApprovalInbox(
    def.status ?? "PENDING_APPROVAL",
    def.kind ?? "WRITE"
  );

  if (isLoading) return <CardListSkeleton />;
  if (isError) return <LoadErrorState onRetry={() => refetch()} />;
  if (items.length === 0) return <EmptyState message={EMPTY_MESSAGES[tab]} />;

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <ProposalCard key={item.id} tab={tab} item={item} approve={approve} reject={reject} />
      ))}
    </ul>
  );
}

/** 기록 ① 조회 결과 — 봇이 실행한 READ 기안. */
export function ReadsTabBody({ useReadRecords }: { useReadRecords: ReadRecordsHook }) {
  const { items, isLoading, isError, refetch, loadMore, hasMore } = useReadRecords();

  if (isLoading) return <CardListSkeleton />;
  if (isError) return <LoadErrorState onRetry={() => refetch()} />;
  if (items.length === 0) return <EmptyState message={EMPTY_MESSAGES.reads} />;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <ReadRecordCard key={item.id} item={item} />
        ))}
      </ul>
      {hasMore && <LoadMoreButton onClick={() => loadMore()} />}
    </div>
  );
}

/** 기록 ② 봇 활동 — 작업 큐 원장. 「완료 포함」 토글 상태는 이 탭이 소유한다. */
export function ActivityTabBody({ useAgentJobs }: { useAgentJobs: AgentJobsHook }) {
  const [includeSucceeded, setIncludeSucceeded] = React.useState(false);
  const toggle = React.useCallback(() => setIncludeSucceeded((prev) => !prev), []);
  const { items, isLoading, isError, refetch, loadMore, hasMore } = useAgentJobs(includeSucceeded);

  if (isLoading) return <TableSkeleton />;
  if (isError) return <LoadErrorState onRetry={() => refetch()} />;
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <SucceededToggle includeSucceeded={includeSucceeded} onToggle={toggle} />
        <EmptyState message={EMPTY_MESSAGES.activity} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <BotActivityTable
        items={items}
        includeSucceeded={includeSucceeded}
        onToggleSucceeded={toggle}
      />
      {hasMore && <LoadMoreButton onClick={() => loadMore()} />}
    </div>
  );
}
