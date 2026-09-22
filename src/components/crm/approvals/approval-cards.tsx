"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2Icon, ZapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ENTITY_TYPE_LABELS } from "@/components/crm/assistant/types";
import { ProposalPayloadPreview } from "@/components/crm/assistant/proposal-payload-preview";
import { SourceBadge } from "./source-badge";

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
  // §6-1 v1.2 추가: 완료 카드의 자동승인 표기용(proposal-card.tsx의 StatusChip 관례 재사용).
  executedBy?: string | null;
};

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

/**
 * 상세(`/approvals/[id]`)로 가는 끈 (Plan 2 Task 5, 설계 §3-B 「카드 제목 링크」).
 *
 * ⛔ 카드 전체(`<li>`)를 링크로 감싸지 말 것 — 이 카드들 안에는 승인·반려·재시도
 * 버튼이 있다. 링크 안의 버튼은 클릭이 어느 쪽으로 갈지 사람도 브라우저도 헷갈린다
 * (조회 결과 카드는 버튼이 없어서 카드 전체를 링크로 둘 수 있었다 — 여기는 다르다).
 */
function DetailLink({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Link
      href={`/approvals/${id}`}
      className="hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {children}
    </Link>
  );
}

function PayloadSummary({ item }: { item: ApprovalInboxItem }) {
  const content = item.payload?.args?.content;
  if (typeof content === "string" && content.length > 0) {
    // 메모 본문 자체를 링크로 만들면 읽는 글에 밑줄이 깔린다 — 끈은 뒤에 짧게 단다.
    return (
      <p className="text-sm text-foreground">
        &quot;{content}&quot;{" "}
        <span className="text-xs text-muted-foreground">
          <DetailLink id={item.id}>자세히</DetailLink>
        </span>
      </p>
    );
  }
  // 생성 기안은 제목만으로 판단할 수 없다(가격·옵션이 제목에 없다). 승인 버튼이 이
  // 카드에 붙어 있으므로 저장될 값도 같은 카드에서 보여야 한다.
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        <DetailLink id={item.id}>{item.title}</DetailLink>
      </p>
      <ProposalPayloadPreview action={item.payload?.action} args={item.payload?.args} />
    </div>
  );
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

// 카드 루트 공통 클래스 — P8: 그림자는 토큰화된 shadow-soft-* 만 쓴다(raw Tailwind
// shadow-sm/md 금지). hover 시 살짝 떠 보이는 정도로만(transition-shadow).
const CARD_ROOT_CLASS =
  "flex flex-col gap-2 rounded-lg border border-border p-4 shadow-soft-sm transition-shadow hover:shadow-soft-md";

/** 대기 카드 — 기존 승인/반려 버튼(M1 pending 처리 무변경). */
export function PendingCard({
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
    <li className={CARD_ROOT_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EntityBadge item={item} />
            <SourceBadge createdBy={item.createdBy} />
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
          승인
        </Button>
        <Button size="sm" variant="outline" onClick={handleReject} disabled={pending}>
          반려
        </Button>
      </div>
    </li>
  );
}

/**
 * 완료 카드 — executedBy==="AGENT"면 자동승인 표기(§6-1, proposal-card 라벨 관례).
 * 색도 그 관례를 따른다: 완료 = `status-success`. ⛔ `status-active`(네이비)로 되돌리지
 * 말 것 — 근거 정본은 proposal-card `StatusChip` 주석(P8 §4 · 생애주기 SSOT).
 * 자동승인 표기는 이모지가 아니라 `ZapIcon`(P8 — 이모지는 UI 아이콘으로 쓰지 않는다).
 */
export function ExecutedCard({ item }: { item: ApprovalInboxItem }) {
  return (
    <li className={CARD_ROOT_CLASS}>
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        {item.executedBy === "AGENT" ? (
          <Badge variant="status-success">
            <ZapIcon className="size-3" />
            자동승인
          </Badge>
        ) : (
          <Badge variant="status-success">실행 완료</Badge>
        )}
        <SourceBadge createdBy={item.createdBy} />
        <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
      </div>
      <PayloadSummary item={item} />
    </li>
  );
}

/**
 * 실패 카드 — errorMessage + [재시도] 버튼(§6-1).
 * useProposalActions.approve를 재사용(FAILED→APPROVED 상태기계 재시도)하며,
 * confirm_settlement이면 proposal-card와 동일한 확인 다이얼로그를 경유한다
 * (§6-1 "금전 가드 일관성" — 취소 시 approve 미호출).
 */
export function FailedCard({
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
    <li className={CARD_ROOT_CLASS}>
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        <Badge variant="destructive">실패</Badge>
        <SourceBadge createdBy={item.createdBy} />
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
          재시도
        </Button>
      </div>
    </li>
  );
}

/** 반려 카드 — 읽기 전용(§6-1). */
export function RejectedCard({ item }: { item: ApprovalInboxItem }) {
  return (
    <li className={CARD_ROOT_CLASS}>
      <div className="flex flex-wrap items-center gap-2">
        <EntityBadge item={item} />
        <Badge variant="outline">반려됨</Badge>
        <SourceBadge createdBy={item.createdBy} />
        <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
      </div>
      <PayloadSummary item={item} />
    </li>
  );
}
