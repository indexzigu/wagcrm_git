"use client";

import { useState } from "react";
import {
  useDraggable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  type OutreachStatus,
} from "@/lib/validations/outreach";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { getDealIdentityParts } from "@/lib/deal-display";


import { ActionBadge } from "./action-badge";
import { calculateFollowUp } from "@/lib/followup-engine";


export type OutreachRow = {
  id: string;
  dealId: string;
  dealName: string;
  brandName: string | null;
  partnerName: string | null;
  sellerId: string;
  sellerName: string;
  sellerFollowers: number | null;
  sellerCategory: string | null;
  snsType: string | null;
  snsHandle: string | null;
  status: OutreachStatus;
  contactChannel?: string | null;
  proposalMessage?: string | null;
  negotiationMemo?: string | null;
  testingMemo?: string | null;
  proposedAt: string;
  acceptedAt: string | null;
  respondedAt?: string | null;
  lastReminderAt?: string | null;
  nextReminderAt?: string | null;
  droppedAt?: string | null;
  dropReason?: string | null;
  totalMarginRate: number;
  sellerMarginRate: number;
  linkedCampaignId: string | null;
  linkedCampaignName: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

type OutreachListProps = {
  outreaches: OutreachRow[];
  onStatusChange: (id: string, newStatus: OutreachStatus) => Promise<void>;
  onCreateCampaign?: (outreachId: string) => Promise<void>;
  onReminderSent?: (outreachId: string) => Promise<void>;
  onDropTask?: (outreachId: string, reason: string) => Promise<void>;
  onSelectTask?: (outreach: OutreachRow) => void;
  /**
   * dnd-kit useDraggable 배선 여부. 작업 컬럼(PROPOSED/NEGOTIATION/TESTING/
   * PENDING_APPROVAL)에서만 true — 터미널 컬럼(CONVERTED/DROPPED) 및 DndContext
   * 밖(셀러/딜 상세)에서는 false로 두어 useDraggable을 호출하지 않는다.
   */
  draggable?: boolean;
};



/** updatedAt 기준으로 현재 상태에 머문 경과일 계산 */
function getDaysInStatus(updatedAt: string | null | undefined, proposedAt: string, now: number): number {
  const base = updatedAt ? new Date(updatedAt) : new Date(proposedAt);
  const diff = now - base.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * 경과일에 따른 라벨 + 색상 클래스.
 *
 * 리터럴 4색(violet·orange·rose·amber)을 `--status-*` 토큰으로 옮겼다(오너 결정 2026-07-30).
 * 자매 모바일(`mobile-outreach-view.tsx`)이 **오너 승인 2026-07-09**로 이미 옮겨간 어휘이고,
 * 데스크톱은 그 결정의 반쪽 마이그레이션 잔여물이었다(DROPPED 만 무채색으로 옮기고 멈춤).
 *
 * ⚠️ **회수가 곧 가독성 개선이다** — 리터럴 3색이 `text-[11px] font-semibold` 에서 AA 미달이었다.
 * 표면은 이 배지가 실제로 앉는 카드 4종(흰 카드 + followUp 틴트 amber/blue/indigo-50/20):
 *   orange-600 3.60~3.51 ❌ · amber-600 3.20~3.12 ❌ · rose-600 4.53(흰 카드만 통과)~4.42 ❌
 *   → status-caution 5.02~4.90 ✅ · status-urgent-text 7.29~7.12 ✅ · slate-500 4.76~4.65 ✅
 *   (orange 를 받던 PENDING_APPROVAL 은 아래 §PENDING_APPROVAL 대로 일 램프에 흡수됐다)
 * (`rose-600` 은 흰 카드에서만 턱걸이 통과라 "통과"로 오판하기 쉽다 — 틴트 카드에서 무너진다.
 *  틴트는 `calculateFollowUp` 이 **status 분기보다 먼저** `nextReminderAt` 룰을 타므로
 *  CONVERTED 를 포함한 어떤 상태에도 붙을 수 있다.)
 *
 * ⚠️ **CONVERTED 는 모바일과 의도적으로 다르다**(오너 결정 2026-07-30). 모바일은
 * `isTerminalStatus`(전환·드랍)를 **한 덩어리로 무채색** 처리하지만, 데스크톱은 전환만
 * `status-success` 로 띄운다. 오너가 무채색안(A)과 생애주기안(B) 중 **B 를 선택**했다 —
 * 칸반 컬럼이 이미 상태를 인코딩하는 이중 인코딩을 감수한 결정이다.
 * **"모바일과 정합"을 이유로 무채색으로 되돌리지 말 것.** DROPPED 는 그대로 무채색이다.
 *
 * ⚠️ **PENDING_APPROVAL 전용 분기는 없다 — 일(day) 램프가 흡수한다**(오너 결정 2026-07-30).
 * 종전에는 `days >= 7`·`days >= 3` **위에** 상태 분기가 있어서 승인대기 건이 1일째든 30일째든
 * 같은 색이었다 — 램프의 존재 이유(지연 심각도)가 그 상태에서만 꺼져 있었다. 하필 그 컬럼이
 * *"캠페인 전환을 기다리는 확정 건"*, 즉 **오너 자신이 병목인 상태**다.
 * 이 카드에 다른 신호가 없다는 것이 결정 근거였다(실측): `calculateFollowUp` 이 이 상태를
 * 다루지 않아 `ActionBadge` 가 `null` 이고 카드 틴트도 안 붙으며, 상태 배지 컴포넌트는
 * 소비처가 0이었다(이 PR 에서 삭제) — board 뷰에서 **유일한 신호가 이 배지**였다.
 * 모바일(`mobile-outreach-view.tsx`)엔 이 분기가 애초에 없다 — 이제 양쪽이 같은 램프다.
 * ⛔ 상태 분기를 램프 **위**에 다시 얹지 말 것: 위에 놓인 축이 아래 축을 가린다.
 */
function getElapsedBadge(days: number, status: OutreachStatus): { label: string; className: string } {
  if (status === "DROPPED") return { label: "종료", className: "text-muted-foreground" };
  if (status === "CONVERTED") return { label: "전환완료", className: "text-status-success font-semibold" };
  if (days === 0) return { label: "오늘", className: "text-slate-500" };
  const label = `${days}일째`;
  if (days >= 7) return { label, className: "text-status-urgent-text font-semibold" };
  if (days >= 3) return { label, className: "text-status-caution font-semibold" };
  return { label, className: "text-slate-500" };
}

/** 현재 상태에 해당하는 메모 내용 반환 */
function getActiveMemo(outreach: OutreachRow): string | null {
  if (outreach.status === "NEGOTIATION" && outreach.negotiationMemo) return outreach.negotiationMemo;
  if (outreach.status === "TESTING" && outreach.testingMemo) return outreach.testingMemo;
  if (outreach.status === "PROPOSED" && outreach.proposalMessage) return outreach.proposalMessage;
  if ((outreach.status === "PENDING_APPROVAL" || outreach.status === "CONVERTED") && outreach.negotiationMemo)
    return outreach.negotiationMemo;
  if (outreach.status === "DROPPED" && outreach.dropReason) return outreach.dropReason;
  return null;
}

/**
 * 카드 본문(presentational). 드래그 계약(dragRef/listeners/attributes/isDragging/
 * isOverlay)을 받아 판매 관리 CampaignCard와 동일한 시각 규약을 따른다. DragOverlay의
 * 들린 카드도 이 컴포넌트를 재사용한다(now를 주입받아 결정론 유지).
 */
export function OutreachCardContent({
  outreach,
  now,
  onSelectTask,
  dragRef,
  dragListeners,
  dragAttributes,
  isDragging = false,
  isOverlay = false,
}: {
  outreach: OutreachRow;
  now: number;
  onSelectTask?: (outreach: OutreachRow) => void;
  dragRef?: (element: HTMLElement | null) => void;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  isDragging?: boolean;
  isOverlay?: boolean;
}) {
  const days = getDaysInStatus(outreach.updatedAt, outreach.proposedAt, now);
  const elapsed = getElapsedBadge(days, outreach.status);
  const memo = getActiveMemo(outreach);

  const followUp = calculateFollowUp(outreach, new Date(now));

  let cardBorder = "border-slate-200 bg-white shadow-soft-sm";
  if (followUp) {
    if (followUp.type === "MANUAL_REMINDER") {
      cardBorder = "border-amber-200 bg-amber-50/20 hover:bg-amber-100/30 border-l-4 border-l-amber-500 shadow-soft-sm";
    } else if (followUp.type === "1ST_REMINDER" || followUp.type === "SAMPLE_CHECK") {
      cardBorder = "border-blue-200 bg-blue-50/20 hover:bg-blue-100/30 border-l-4 border-l-blue-500 shadow-soft-sm";
    } else if (followUp.type === "2ND_REMINDER") {
      cardBorder = "border-indigo-200 bg-indigo-50/20 hover:bg-indigo-100/30 border-l-4 border-l-indigo-500 shadow-soft-sm";
    }
  }

  return (
    <div
      ref={dragRef}
      {...dragAttributes}
      {...dragListeners}
      style={dragListeners ? { touchAction: "none" } : undefined}
      className={cn(
        "rounded-2xl border px-3.5 py-3 transition-[translate,scale,rotate,opacity,box-shadow,border-color,background-color] duration-200",
        cardBorder,
        // 드래그 핸들 부착 시 dnd-kit이 tabindex/role 주입 → 키보드 포커스 가능. 앱 전역 --focus-ring 토큰(WCAG 1.4.11).
        // inset이라 틴트 배경(앰버/블루/인디고)에도 흰 테 아티팩트 없음 + 컬럼 outer 하이라이트와 시각 구분. CampaignCard와 동일.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
        // 드래그 핸들이 없으면(정적/터미널 컬럼) 기존처럼 클릭 포인터
        dragListeners ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        // 오버레이가 아닐 때만 hover 리프트 적용 (판매관리 칸반과 동일)
        !isOverlay && "hover:-translate-y-0.5 hover:shadow-soft-md hover:border-primary/15",
        // 원본은 드래그 중 흐리게(오버레이가 실제로 보이는 카드)
        isDragging && "opacity-40",
        // 들린 카드: 살짝 떠서 기울어짐 (CampaignCard와 동일 규약)
        isOverlay && "cursor-grabbing rotate-1 scale-[1.02] shadow-soft-lg border-primary/20",
      )}
      onClick={() => onSelectTask?.(outreach)}
    >
      <div className="flex flex-col gap-1.5">
        {/* 1행: 셀러이름 + 액션배지 | 경과일 */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <SellerIdentityInfo
              sellerName={outreach.sellerName}
              snsType={outreach.snsType}
              snsHandle={null}
              variant="compact"
              hideSns={false}
            />
            <ActionBadge task={outreach} referenceDate={new Date(now)} />
          </div>
          <span className={`shrink-0 text-[11px] font-semibold ${elapsed.className}`}>
            {elapsed.label}
          </span>
        </div>

        {/* 2행: 딜명 | 브랜드 | 거래처 정보 (충분한 너비 활용) */}
        <div className="mt-0.5 w-full">
          <EntityIdentity
            parts={getDealIdentityParts({
              dealName: outreach.dealName,
              brandName: outreach.brandName,
              partnerName: outreach.partnerName,
            })}
            variant="compact"
            className="w-full flex-wrap gap-x-2 gap-y-1"
          />
        </div>

        {/* 3행: 협의 수수료 (PROPOSED 단계가 아닐 때 노출) */}
        {outreach.status !== "PROPOSED" && (
          <div className="mt-0.5 flex items-center text-[11px] text-muted-foreground">
            <span>총수수료 <span className="font-semibold text-slate-600">{outreach.totalMarginRate}%</span></span>
            <span className="mx-1.5 text-border/60">·</span>
            <span>협의수수료 <span className="font-semibold text-slate-600">{outreach.sellerMarginRate}%</span></span>
          </div>
        )}
      </div>

      {/* 메모가 있으면 항상 카드 하단에 일관되게 표시 */}
      {memo && (
        <div className="mt-2 rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-1.5 text-[11px] text-slate-600 line-clamp-1 leading-relaxed">
          {memo}
        </div>
      )}
    </div>
  );
}

/**
 * useDraggable로 OutreachCardContent를 감싼다. DndContext 안(작업 컬럼)에서만 렌더된다.
 * 카드 계약(dragRef/listeners/attributes/isDragging)은 CampaignCard와 동일 패턴.
 */
function DraggableOutreachCard({
  outreach,
  now,
  onSelectTask,
}: {
  outreach: OutreachRow;
  now: number;
  onSelectTask?: (outreach: OutreachRow) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: outreach.id,
  });

  return (
    <OutreachCardContent
      outreach={outreach}
      now={now}
      onSelectTask={onSelectTask}
      dragRef={setNodeRef}
      dragListeners={listeners}
      dragAttributes={attributes}
      isDragging={isDragging}
    />
  );
}

export function OutreachList({
  outreaches,
  onSelectTask,
  draggable = false,
}: OutreachListProps) {
  const [now] = useState(() => Date.now());

  if (outreaches.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>제안 이력이 없습니다</EmptyTitle>
          <EmptyDescription>이 딜에 대한 영업 테스크 이력이 없습니다.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-[15px]">
      {outreaches.map((outreach) =>
        draggable ? (
          <DraggableOutreachCard
            key={outreach.id}
            outreach={outreach}
            now={now}
            onSelectTask={onSelectTask}
          />
        ) : (
          <OutreachCardContent
            key={outreach.id}
            outreach={outreach}
            now={now}
            onSelectTask={onSelectTask}
          />
        ),
      )}
    </div>
  );
}
