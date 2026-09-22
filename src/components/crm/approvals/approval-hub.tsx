"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";
import { useReadRecords } from "@/hooks/useReadRecords";
import { useAgentJobs } from "@/hooks/useAgentJobs";
import { useFilterParams } from "@/hooks/use-filter-params";
import { APPROVALS_TABS, parseTab } from "./approvals-tabs";
import type { ApprovalsTab, ApprovalsTabDef } from "./approvals-tabs";
import type { ApprovalHubHooks } from "./approval-hub-types";
import { ActivityTabBody, ProposalTabBody, ReadsTabBody } from "./hub-tab-bodies";

export type { ApprovalHubHooks } from "./approval-hub-types";

/** URL 의 `?tab=` 한 개만 읽는다 — 결재함은 다른 필터를 쓰지 않는다. */
function useTabFromUrl(): string | undefined {
  return useFilterParams().filters.tab;
}

const DEFAULT_HOOKS: ApprovalHubHooks = {
  useApprovalInbox,
  useReadRecords,
  useAgentJobs,
  useTab: useTabFromUrl,
};

const SEGMENTS: ReadonlyArray<ApprovalsTabDef["segment"]> = ["기안", "기록"];

function TabLink({
  tab,
  active,
  count,
}: {
  tab: ApprovalsTabDef;
  active: boolean;
  count: number;
}) {
  return (
    <Link
      href={`/approvals?tab=${tab.id}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 border-b-2 px-2 pb-1.5 text-sm transition-colors",
        active
          ? "border-primary font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {tab.label}
      {/* 0이면 배지를 숨긴다 — 「0」은 판단을 바꾸지 않는데 시선만 가져간다. */}
      {tab.countBadge && count > 0 && (
        <Badge size="count" variant={tab.id === "failed" ? "destructive" : "status-pending"}>
          {count}
        </Badge>
      )}
    </Link>
  );
}

/**
 * ApprovalHub — 결재함(/approvals) 본체 (Plan 2 Task 4).
 *
 * 이 화면이 돕는 판단은 둘이다: ①지금 내 결재가 필요한 기안이 있는가(기안 4탭)
 * ②봇이 무엇을 조회했고 어디서 막혔는가(기록 2탭). 그래서 탭바도 그 두 무리로
 * 나뉘고, 배지는 ①에 속한 두 탭(대기·실패)에만 붙는다 — 배지를 전부에 달면
 * "손이 필요하다"는 신호가 희석된다.
 *
 * 탭은 ARIA 탭 위젯이 아니라 **링크**다. 각 탭이 고유 URL(`?tab=`)을 가져야
 * 새로고침·뒤로가기·북마크가 성립하고, 슬랙 알림에서 특정 탭으로 바로 들어올 수 있다.
 *
 * `hooks` 는 테스트 주입구다(기본값 = 실제 훅) — 네트워크 없이 탭·상태 전환을
 * 검증하기 위한 것이고, 제품 코드에서 넘기지 않는다.
 */
export function ApprovalHub({ hooks }: { hooks?: Partial<ApprovalHubHooks> } = {}) {
  const resolved = React.useMemo(() => ({ ...DEFAULT_HOOKS, ...hooks }), [hooks]);
  const tab: ApprovalsTab = parseTab(resolved.useTab());

  // 배지용 건수는 탭과 무관하게 항상 읽는다 — 다른 탭에 있어도 "대기 3건"이 보여야
  // 결재함에 들어온 목적을 놓치지 않는다. 본문과 같은 쿼리키라 요청은 겹치지 않는다.
  const pendingInbox = resolved.useApprovalInbox("PENDING_APPROVAL", "WRITE");
  const failedInbox = resolved.useApprovalInbox("FAILED", "WRITE");
  const counts: Record<string, number> = {
    pending: pendingInbox.count,
    failed: failedInbox.count,
  };

  return (
    <>
      <nav className="flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-border/70 px-5 py-3">
        {SEGMENTS.map((segment, index) => (
          <React.Fragment key={segment}>
            {index > 0 && (
              <span aria-hidden className="mx-2 h-4 border-l border-border/70" />
            )}
            <span className="mr-1 text-[10px] uppercase tracking-[0.05em] text-slate-500">
              {segment}
            </span>
            {APPROVALS_TABS.filter((def) => def.segment === segment).map((def) => (
              <TabLink
                key={def.id}
                tab={def}
                active={def.id === tab}
                count={counts[def.id] ?? 0}
              />
            ))}
          </React.Fragment>
        ))}
      </nav>

      <div className="p-5">
        {tab === "reads" ? (
          <ReadsTabBody useReadRecords={resolved.useReadRecords} />
        ) : tab === "activity" ? (
          <ActivityTabBody useAgentJobs={resolved.useAgentJobs} />
        ) : (
          <ProposalTabBody tab={tab} useApprovalInbox={resolved.useApprovalInbox} />
        )}
      </div>
    </>
  );
}
