"use client";

import * as React from "react";
import { Loader2Icon, InboxIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";
import type { ActionProposalStatus } from "@/repositories/actionProposalRepository";
import { ENTITY_TYPE_LABELS } from "./types";

/** /api/action-proposals GET 응답 항목 형태 (route.ts와 형태를 맞춘다). */
export type ApprovalInboxItem = {
  id: string;
  title: string;
  status: string;
  kind: string;
  targetEntityType: string | null;
  targetEntityId: string | null;
  targetEntityName: string | null;
  payload: { action?: string; args?: Record<string, unknown> } | null;
  createdBy: string;
  createdAt: string;
  errorMessage?: string | null;
  // §6-1 v1.2 추가: 완료 탭의 ⚡자동승인 표기용(proposal-card.tsx의 StatusChip 관례 재사용).
  executedBy?: string | null;
};

// §6-1 인박스 상태 탭 4개 — 목록 API의 VALID_STATUSES 화이트리스트 중 UI에 노출할 부분집합
// (DRAFT/APPROVED는 사용자 액션 대상이 아니라 탭에서 제외한다).
const INBOX_TABS: Array<{ status: ActionProposalStatus; label: string }> = [
  { status: "PENDING_APPROVAL", label: "대기" },
  { status: "EXECUTED", label: "완료" },
  { status: "FAILED", label: "실패" },
  { status: "REJECTED", label: "반려" },
];

// 정산(confirm_settlement) 승인은 카드(proposal-card.tsx)와 동일한 확인 다이얼로그를
// 거친다(§6-1 "금전 가드 일관성") — 문구도 동일하게 맞춘다.
const SETTLEMENT_ACTION = "confirm_settlement";
const SETTLEMENT_CONFIRM_MESSAGE = "정산 확정은 되돌릴 수 없습니다. 승인하시겠습니까?";

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function PayloadSummary({ item }: { item: ApprovalInboxItem }) {
  const content = item.payload?.args?.content;
  if (typeof content === "string" && content.length > 0) {
    return <p className="text-sm text-foreground">&quot;{content}&quot;</p>;
  }
  return <p className="text-sm text-muted-foreground">{item.title}</p>;
}

function EntityBadge({ item }: { item: ApprovalInboxItem }) {
  const entityLabel = item.targetEntityType ? ENTITY_TYPE_LABELS[item.targetEntityType] ?? item.targetEntityType : null;
  if (!entityLabel) return null;
  return (
    <Badge variant="outline">
      {entityLabel}
      {item.targetEntityName ? `: ${item.targetEntityName}` : ""}
    </Badge>
  );
}

/** 대기 탭 카드 — 기존 승인/반려 버튼(M1 pending 처리 무변경). */
function PendingCard({
  item,
  onApprove,
  onReject,
}: {
  item: ApprovalInboxItem;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(item.errorMessage ?? null);
  // 언마운트된 뒤(성공 시 목록에서 빠짐) setState를 호출하지 않기 위한 가드.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // M1 [Major, 차단] 수정: onApprove/onReject가 반환하는 Promise를 반드시 await하고,
  // 성공/실패 어느 경로든 finally에서 pending을 해제한다. 이전에는 fire-and-forget이라
  // (promise 미반환) finally가 즉시 실행되어 실패 시(409/500/502) 버튼이 영구 disabled에
  // 스피너가 무한 회전했다 — 유일한 복구가 새로고침이라 HITL 운영 화면에서 치명적이었다.
  // 성공 시엔 부모가 목록을 갱신해 이 카드가 언마운트되므로 pending 해제가 보이지 않을 뿐,
  // 실패 시엔 이 카드가 그대로 남아 pending=false + 에러 문구 + 재클릭 가능 상태가 된다.
  const handleApprove = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onApprove(item.id);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "승인 처리 중 오류가 발생했습니다.");
      }
    } finally {
      if (mountedRef.current) {
        setPending(false);
      }
    }
  };

  const handleReject = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onReject(item.id);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "반려 처리 중 오류가 발생했습니다.");
      }
    } finally {
      if (mountedRef.current) {
        setPending(false);
      }
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EntityBadge item={item} />
            <span className="text-xs text-muted-foreground">기안자: {item.createdBy}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
          </div>
          <div className="mt-1.5">
            <PayloadSummary item={item} />
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleApprove} disabled={pending}>
          {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          승인 및 실행
        </Button>
        <Button size="sm" variant="outline" onClick={handleReject} disabled={pending}>
          반려
        </Button>
      </div>
    </li>
  );
}

/**
 * 완료 탭 카드 — executedBy==="AGENT"면 ⚡자동승인 표기(§6-1, proposal-card 라벨 관례).
 * 색도 그 관례를 따른다: 완료 = `status-success`. ⛔ `status-active`(네이비)로 되돌리지
 * 말 것 — 근거 정본은 proposal-card `StatusChip` 주석(P8 §4 · 생애주기 SSOT).
 */
function ExecutedCard({ item }: { item: ApprovalInboxItem }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        {item.executedBy === "AGENT" ? (
          <Badge variant="status-success">⚡자동승인</Badge>
        ) : (
          <Badge variant="status-success">실행 완료</Badge>
        )}
        <span className="text-xs text-muted-foreground">기안자: {item.createdBy}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
      </div>
      <PayloadSummary item={item} />
    </li>
  );
}

/**
 * 실패 탭 카드 — errorMessage + [재시도(승인)] 버튼(§6-1).
 * useProposalActions.approve를 재사용(FAILED→APPROVED 상태기계 재시도)하며,
 * confirm_settlement이면 proposal-card와 동일한 확인 다이얼로그를 경유한다
 * (§6-1 "금전 가드 일관성" — 취소 시 approve 미호출).
 */
function FailedCard({
  item,
  onApprove,
}: {
  item: ApprovalInboxItem;
  onApprove: (id: string) => Promise<unknown>;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isSettlement = item.payload?.action === SETTLEMENT_ACTION;

  const handleRetry = async () => {
    if (pending) return;
    if (isSettlement) {
      const confirmed = window.confirm(SETTLEMENT_CONFIRM_MESSAGE);
      if (!confirmed) return;
    }
    setPending(true);
    setError(null);
    try {
      await onApprove(item.id);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "재시도 처리 중 오류가 발생했습니다.");
      }
    } finally {
      if (mountedRef.current) {
        setPending(false);
      }
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        <Badge variant="destructive">실패</Badge>
        <span className="text-xs text-muted-foreground">기안자: {item.createdBy}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
      </div>
      <PayloadSummary item={item} />

      {item.errorMessage && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {item.errorMessage}
        </p>
      )}

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleRetry} disabled={pending}>
          {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          재시도(승인)
        </Button>
      </div>
    </li>
  );
}

/** 반려 탭 카드 — 읽기 전용(§6-1). */
function RejectedCard({ item }: { item: ApprovalInboxItem }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        <Badge variant="outline">반려됨</Badge>
        <span className="text-xs text-muted-foreground">기안자: {item.createdBy}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
      </div>
      <PayloadSummary item={item} />
    </li>
  );
}

export function ApprovalInbox({
  className,
  useApprovalInboxHook = useApprovalInbox,
}: {
  className?: string;
  useApprovalInboxHook?: typeof useApprovalInbox;
}) {
  // §6-1: 상단 탭 4개(대기/완료/실패/반려) — 탭 전환은 status별 쿼리로, react-query
  // 캐시가 있어 재방문 시 즉시 표시된다(청사진 §6-1 "재방문 즉시 표시").
  const [activeStatus, setActiveStatus] = React.useState<ActionProposalStatus>("PENDING_APPROVAL");
  const { items, isLoading, approve, reject } = useApprovalInboxHook(activeStatus);

  // M1 수정: approve/reject 호출의 Promise를 그대로 카드에 돌려준다 — 카드가 직접 await하고
  // 자신의 로컬 error state로 실패를 표시한 뒤 pending을 해제한다(§PendingCard).
  // 이전에는 여기서 .catch로 소비하고 undefined를 반환해(fire-and-forget) 카드가 완료를
  // 기다릴 방법이 없었다 — 그래서 실패해도 finally가 이미 지나가 pending이 풀리지 않았다.
  const handleApprove = (id: string) => approve(id);
  const handleReject = (id: string) => reject(id);

  const emptyMessage: Record<ActionProposalStatus, string> = {
    DRAFT: "항목이 없습니다.",
    PENDING_APPROVAL: "승인 대기 중인 요청이 없습니다.",
    APPROVED: "항목이 없습니다.",
    EXECUTED: "완료된 요청이 없습니다.",
    FAILED: "실패한 요청이 없습니다.",
    REJECTED: "반려된 요청이 없습니다.",
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="mb-3 flex items-center gap-2">
        <InboxIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">승인 대기함</h2>
        {activeStatus === "PENDING_APPROVAL" && items.length > 0 && (
          <Badge variant="status-pending">{items.length}건</Badge>
        )}
      </div>

      <div role="tablist" className="mb-3 flex items-center gap-1 border-b border-border">
        {INBOX_TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={activeStatus === tab.status}
            onClick={() => setActiveStatus(tab.status)}
            className={cn(
              "rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeStatus === tab.status
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          불러오는 중...
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{emptyMessage[activeStatus]}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            if (activeStatus === "EXECUTED") {
              return <ExecutedCard key={item.id} item={item} />;
            }
            if (activeStatus === "FAILED") {
              return <FailedCard key={item.id} item={item} onApprove={handleApprove} />;
            }
            if (activeStatus === "REJECTED") {
              return <RejectedCard key={item.id} item={item} />;
            }
            return (
              <PendingCard key={item.id} item={item} onApprove={handleApprove} onReject={handleReject} />
            );
          })}
        </ul>
      )}
    </div>
  );
}
