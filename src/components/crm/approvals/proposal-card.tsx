"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2Icon, ShieldCheckIcon, ZapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useProposalActions } from "@/hooks/useProposalActions";
import { ENTITY_TYPE_LABELS, actionHasNoTargetYet } from "./entity-type-labels";
import { RejectConfirmButton } from "./reject-confirm-button";
import { ProposalPayloadPreview } from "./proposal-payload-preview";
import { PartnerInvoiceEnrichment } from "./partner-invoice-enrichment";
import type { PartnerEnrichment } from "@/lib/agent/partner-enrichment";
import type { ProposalArgLabels } from "@/lib/agent/resolve-entity-label";
import { displayLabel, UNKNOWN_NAME } from "@/lib/display-label";
import { ACTION_LABELS } from "@/lib/agent/action-labels";

/**
 * ProposalCard — 기안 한 건의 카드(인라인 승인) (청사진 §1, §3-#4).
 *
 * 소비처는 결재함 상세(`/approvals/[id]`)다. 기안 id 로 마운트되면 GET
 * /api/action-proposals/[id]를 react-query로 가져와(§1-1) 상태 칩+인라인
 * 액션을 그린다. refetchOnWindowFocus:true — 다른 탭(결재함 목록)에서 승인한
 * 카드가 이 화면에 stale PENDING으로 남지 않도록 한다(critic #2).
 */

export { ACTION_LABELS };

// confirm_settlement만 승인 시 확인 다이얼로그를 거친다(§1-3, critic Q4 — 금전 최고위험 액션).
const SETTLEMENT_ACTION = "confirm_settlement";
const SETTLEMENT_CONFIRM_MESSAGE = "정산 확정은 되돌릴 수 없습니다. 승인하시겠습니까?";

type ProposalDetail = {
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
  executedBy?: string | null;
  errorMessage?: string | null;
  /** [캘린더수집] 기안 출처 칸·새 회차 이름 — 목록 카드(`ApprovalInboxItem`)와 같은 칸. */
  sourceRef?: unknown;
  argLabels?: ProposalArgLabels | null;
};

async function fetchProposal(id: string): Promise<ProposalDetail> {
  const res = await fetch(`/api/action-proposals/${id}`);
  if (!res.ok) {
    throw new Error(`기안 조회 실패 (status=${res.status})`);
  }
  return res.json();
}

/**
 * 상태 칩 6종 (§1-2 표). EXECUTED+executedBy==="AGENT"만 특수 라벨.
 *
 * ⛔ **「완료」는 `status-success` 다 — `status-active`(브랜드 네이비)로 되돌리지 말 것**
 * (오너 승인 2026-08-26). 이 주석이 결재함 표면 3개 파일의 **어휘 정본**이다:
 * `components/crm/approvals/approval-cards`(완료 카드) · `tool-result-views`(입금/지급 완료)
 * 가 이 표의 관례를 재사용한다 — 값은 여기 한 곳에만 적는다(채팅 전용이던
 * `evidence-table` 은 은퇴).
 *
 * 근거 두 겹:
 * ① P8 §4 는 브랜드 네이비 틴트를 "5개 의미축의 hue 가 아니라 **중립 태그 캐리어**"로만
 *    허용하고 *"이 틴트를 판정·심각도 의미로 쓰는 것은 금지"* 한다. 이 칩은 "끝났다/안
 *    끝났다"는 판정을 나르므로 그 금지 용법이었다.
 * ② 더 나쁜 것은 **의미가 정반대**였다는 점이다 — 생애주기 SSOT(`StatusBadge`, 가드레일 2)
 *    에서 `status-active` 는 PROPOSAL·ACTIVE(=**진행 중**)이고 COMPLETED 가
 *    `status-success` 다. 「실행완료」에 네이비를 칠하면 앱 전역 어휘와 충돌한다.
 *
 * 같은 위반을 모바일 캠페인 상세 시트에서 먼저 고쳤다(PR #486, 오너 승인 2026-08-26).
 * 신규 hue 가 아니라 기존 생애주기축 어휘 재사용이므로 가드레일 2 위반이 아니다.
 *
 * ⛔ 대기·미확정 쪽까지 유채색으로 올리지 말 것 — P8 §2("무채색은 랭크지 부재가 아니다").
 *    아직 일어나지 않은 사건은 `outline`/`secondary` 무채가 정답이다.
 */
function StatusChip({ proposal }: { proposal: ProposalDetail }) {
  if (proposal.status === "PENDING_APPROVAL") {
    return <Badge variant="status-pending">승인대기</Badge>;
  }
  if (proposal.status === "APPROVED") {
    return <Badge variant="status-info">승인됨·실행중</Badge>;
  }
  if (proposal.status === "EXECUTED") {
    // 정산 금액 수정 자동 실행기(슬랙 원문 대조·한도 안)가 승인한 건 — approval-cards 완료 카드와 같은 낱말.
    if (proposal.executedBy === "SYSTEM_AUTO") {
      return (
        <Badge variant="status-success">
          <ShieldCheckIcon className="size-3" aria-hidden />
          자동 실행 · 한도 안
        </Badge>
      );
    }
    if (proposal.executedBy === "AGENT") {
      return (
        <Badge variant="status-success">
          <ZapIcon className="size-3" />
          자동승인·실행됨
        </Badge>
      );
    }
    return <Badge variant="status-success">실행완료</Badge>;
  }
  if (proposal.status === "FAILED") {
    return <Badge variant="destructive">실패</Badge>;
  }
  if (proposal.status === "REJECTED") {
    return <Badge variant="outline">반려됨</Badge>;
  }
  if (proposal.status === "DRAFT") {
    // 가격표 반영 기안이 승인대기로 넘어가기 전 잠깐 머무는 상태(장애 시 남는다).
    return <Badge variant="outline">작성중</Badge>;
  }
  // 모르는 상태 코드는 영문으로 내지 않는다(P2 화면 문구 기준 ③) — 위 분기에 등록하는 것이 수정이다.
  // 승인 여부를 가늠하는 칸이라 빈 표시(—)보다 낱말이 되묻기를 줄인다(ss-ux 검토 2026-10-15).
  return <Badge variant="outline">{UNKNOWN_NAME}</Badge>;
}

export function ProposalCard({
  id,
  useProposalActionsHook = useProposalActions,
}: {
  id: string;
  useProposalActionsHook?: typeof useProposalActions;
}) {
  const query = useQuery({
    queryKey: ["action-proposal", id],
    queryFn: () => fetchProposal(id),
    refetchOnWindowFocus: true,
  });

  const { approve, reject } = useProposalActionsHook();
  const [pending, setPending] = React.useState(false);
  // 거래처 등록 기안에서 「계산서에서 채우기」로 고른 값 — 승인 요청에 함께 싣는다.
  const [partnerEnrichment, setPartnerEnrichment] = React.useState<PartnerEnrichment | undefined>();
  const [error, setError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleApprove = async () => {
    if (pending) return;
    const action = query.data?.payload?.action;
    if (action === SETTLEMENT_ACTION) {
      const confirmed = window.confirm(SETTLEMENT_CONFIRM_MESSAGE);
      if (!confirmed) return;
    }
    setPending(true);
    setError(null);
    try {
      await (partnerEnrichment ? approve(id, { partnerEnrichment }) : approve(id));
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
      await reject(id);
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

  if (query.isLoading) {
    return (
      <div
        data-testid="proposal-card"
        className="flex items-center gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground"
      >
        <Loader2Icon className="size-3.5 animate-spin" />
        기안 정보를 불러오는 중...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div
        data-testid="proposal-card"
        className="rounded-lg border border-border p-3 text-xs text-muted-foreground"
      >
        기안 {id.slice(0, 8)}: 불러오기 실패
      </div>
    );
  }

  const proposal = query.data;
  const action = proposal.payload?.action;
  const actionLabel = displayLabel(ACTION_LABELS, action, UNKNOWN_NAME);
  const isSettlement = action === SETTLEMENT_ACTION;
  // [캘린더수집] 새 회차 생성은 대상 캠페인이 아직 없다 — 이름 없는 「캠페인」 배지를 달지 않는다.
  const entityLabel = proposal.targetEntityType && !actionHasNoTargetYet(action)
    ? displayLabel(ENTITY_TYPE_LABELS, proposal.targetEntityType, "") || null
    : null;

  return (
    <div
      data-testid="proposal-card"
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        isSettlement ? "border-destructive/40 bg-destructive/5" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{actionLabel}</Badge>
        {entityLabel && (
          <Badge variant="outline">
            {entityLabel}
            {proposal.targetEntityName ? `: ${proposal.targetEntityName}` : ""}
          </Badge>
        )}
        <StatusChip proposal={proposal} />
      </div>

      <p className="text-sm text-foreground">{proposal.title}</p>

      {/* 제목은 무엇을 만드는지만 말한다. 승인 판단에 필요한 값(가격·옵션·담당자)은 여기 있다. */}
      <ProposalPayloadPreview
        action={proposal.payload?.action}
        args={proposal.payload?.args}
        sourceRef={proposal.sourceRef}
        argLabels={proposal.argLabels}
        targetEntityName={proposal.targetEntityName}
      />

      {/* 실패(FAILED) 재시도에는 붙이지 않는다 — 첫 승인 때 채운 값은 이미 기안에 저장돼 있다. */}
      {action === "create_partner" && proposal.status === "PENDING_APPROVAL" && (
        <PartnerInvoiceEnrichment proposalId={id} onSelectedChange={setPartnerEnrichment} />
      )}

      {proposal.status === "FAILED" && proposal.errorMessage && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-status-urgent-text">
          {proposal.errorMessage}
        </p>
      )}

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-status-urgent-text">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        {proposal.status === "PENDING_APPROVAL" && (
          <>
            <Button size="sm" onClick={handleApprove} disabled={pending}>
              {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              승인
            </Button>
            <RejectConfirmButton onReject={handleReject} disabled={pending} />
          </>
        )}

        {/* ⛔ 「재시도(승인)」로 되돌리지 말 것 — 버튼 하나에 동사 하나다. 이 카드는
            결재함 상세(`/approvals/[id]`, Plan 2 Task 5)에도 얹히는데, 그 화면에서
            누르는 일은 「다시 해봐」 하나뿐이다(괄호는 구현 설명이지 사용자의 일이
            아니다). 실제로 approve(id) 를 부르는 것은 그대로다. */}
        {proposal.status === "FAILED" && (
          <Button size="sm" onClick={handleApprove} disabled={pending}>
            {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            재시도
          </Button>
        )}
      </div>
    </div>
  );
}
