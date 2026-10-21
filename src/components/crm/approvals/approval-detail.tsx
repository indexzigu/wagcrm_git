"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { ProposalCard } from "./proposal-card";
import { CardListSkeleton } from "./hub-states";
import { ReadDetailHeader } from "./read-detail-header";
import { ReadResultBody, isReadEnvelope } from "./read-result-body";
import { formatShortDateTime } from "./format-time";
import { SourceBadge } from "./source-badge";

/**
 * ApprovalDetail — 결재함 상세 `/approvals/[id]` (Plan 2 Task 5).
 *
 * 한 주소가 두 종류를 연다. 목록(결재함)에서 카드를 누르면 여기로 오는데, 그 카드가
 * 결재할 **기안**(WRITE)일 수도 있고 봇이 남긴 **조회 결과**(READ)일 수도 있다.
 *
 * - WRITE 는 채팅에서 쓰던 기안 카드를 그대로 얹는다. ⛔ 승인·반려·재시도 버튼을
 *   여기에 다시 만들지 말 것 — 두 벌이 되면 확인 다이얼로그(정산 확정)처럼 한쪽에만
 *   있는 방어가 생긴다.
 * - READ 는 이 화면이 직접 그린다(머리 + 본문).
 *
 * 훅을 주입할 수 있게 둔 이유는 테스트다 — 실제 훅은 fetch 를 타고, 화면이 지는
 * 책임은 「받은 데이터로 무엇을 그리는가」뿐이다.
 */

export type ApprovalDetailData = {
  id: string;
  title: string;
  kind: string;
  status: string;
  createdBy: string;
  createdAt: string;
  resultSummary?: string | null;
  structuredResult?: unknown;
};

export type ApprovalDetailHook = (id: string) => {
  /** `null` = 그런 기안이 없다(404). `undefined` = 아직 모른다. */
  data: ApprovalDetailData | null | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
};

/**
 * 404 는 실패가 아니라 **답**이다 — 그래서 던지지 않고 `null` 로 돌려준다.
 * 던지면 「없는 기안」과 「못 불러온 기안」이 같은 얼굴이 되고, 운영자는 다시
 * 불러오기만 누르게 된다.
 */
async function fetchApprovalDetail(id: string): Promise<ApprovalDetailData | null> {
  const res = await fetch(`/api/action-proposals/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`기안 조회 실패 (status=${res.status})`);
  return res.json();
}

const useApprovalDetail: ApprovalDetailHook = (id) => {
  // ⛔ 기안 카드(`proposal-card`)의 `["action-proposal", id]` 를 쓰지 말 것 — **같은 키에
  // 서로 다른 queryFn** 이 걸린다. 카드의 fetcher 는 404 를 던지고 이쪽은 `null` 로
  // 돌려주므로, 두 컴포넌트가 한 화면에 있으면 먼저 마운트된 쪽의 함수가 캐시를
  // 채운다 — 없는 기안이 「불러오기 실패」로 보이거나 그 반대가 된다(어느 쪽이 이길지
  // 마운트 순서가 정한다). 무효화는 `useProposalActions` 가 두 키를 함께 친다.
  const query = useQuery({
    queryKey: ["approval-detail", id],
    queryFn: () => fetchApprovalDetail(id),
    refetchOnWindowFocus: true,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
};

function BackLink() {
  return (
    <Link
      href="/approvals"
      className={`${buttonVariants({ variant: "ghost", size: "sm" })} focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
    >
      <ChevronLeftIcon aria-hidden className="size-4" />
      결재함
    </Link>
  );
}

/**
 * 허브(`/approvals`)와 같은 컨테이너다 — 목록에서 상세로 넘어갈 때 바탕이 바뀌지 않는다.
 *
 * 페이지 머리는 두지 않는다(오너 디자인 방침 2026-10-21). 이 기안의 제목은 페이지 제목이 아니라
 * **내용**이라 카드 안 첫 줄에 두고, 되돌아가기 링크는 같은 줄 오른쪽 끝이다. 제목을 아직 모르는
 * 상태(로딩·실패·없음)에서는 링크만 그 줄에 선다 — 「결재함」 같은 페이지 제목을 채우지 않는다.
 *
 * 기안(WRITE)은 ProposalCard 가 제목을 이미 그리므로 이 줄에 제목을 또 두지 않는다 — 대신
 * 출처·시각(옛 머리 설명 「기안 · 출처 · 시각」의 나머지)을 왼쪽에 둔다(`lead`).
 */
function DetailShell({
  subject,
  lead,
  children,
}: {
  subject?: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <CrmShell>
      <div className="px-5 pb-5 pt-5 md:px-8">
        <div className="flex flex-col rounded-2xl border border-border bg-card shadow-ambient">
          <div
            data-testid="approval-detail-toolbar"
            className="flex items-center justify-between gap-3 border-b border-border px-5 py-3"
          >
            {subject ? (
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{subject}</h2>
            ) : lead ? (
              <div className="flex min-w-0 items-center gap-2">{lead}</div>
            ) : (
              <span />
            )}
            <BackLink />
          </div>
          {children}
        </div>
      </div>
    </CrmShell>
  );
}

export function ApprovalDetail({
  id,
  useDetailHook = useApprovalDetail,
}: {
  id: string;
  useDetailHook?: ApprovalDetailHook;
}) {
  const { data, isLoading, isError, refetch } = useDetailHook(id);

  if (isLoading) {
    return (
      <DetailShell>
        <div className="p-5">
          <CardListSkeleton rows={2} />
        </div>
      </DetailShell>
    );
  }

  if (isError) {
    return (
      <DetailShell>
        {/* 실패와 「없음」은 다른 얼굴이어야 한다 — 하나는 다시 해볼 일이고 하나는 아니다. */}
        <div role="alert" className="flex flex-col items-start gap-2 p-5">
          <p className="text-sm text-muted-foreground">기안을 불러오지 못했습니다.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            다시 불러오기
          </Button>
        </div>
      </DetailShell>
    );
  }

  if (!data) {
    return (
      <DetailShell>
        <div className="p-5">
          <p className="text-sm text-muted-foreground">기안을 찾을 수 없습니다.</p>
        </div>
      </DetailShell>
    );
  }

  const isRead = data.kind === "READ";
  const envelope = isReadEnvelope(data.structuredResult) ? data.structuredResult : null;

  if (!isRead) {
    return (
      <DetailShell
        lead={
          <>
            <SourceBadge createdBy={data.createdBy} />
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatShortDateTime(data.createdAt)}
            </span>
          </>
        }
      >
        <div className="p-5">
          <ProposalCard id={id} />
        </div>
      </DetailShell>
    );
  }

  return (
    <DetailShell subject={data.title}>
      <ReadDetailHeader
        envelope={envelope}
        createdBy={data.createdBy}
        createdAt={data.createdAt}
        resultSummary={data.resultSummary}
      />
      <div className="p-5">
        <ReadResultBody envelope={data.structuredResult} />
      </div>
    </DetailShell>
  );
}
