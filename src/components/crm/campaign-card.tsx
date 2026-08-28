"use client";

import * as React from "react";
import { MoreHorizontal, Globe, Calendar, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, badgeSizeClassName } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { type CampaignRow, salesChannelLabels } from "@/lib/crm-types";
import {
  formatCampaignActionDate,
  getCampaignAction,
  type CampaignActionTone,
} from "@/lib/campaign-actions";
import {
  isInSetupWindow,
  needsChannelAssignment,
  needsOrderRegistration,
} from "@/lib/campaign-setup";
import { formatDateRange, getDateUrgency, type DateUrgency } from "@/lib/date-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignCardProps {
  campaign: CampaignRow;
  onOpen: (campaign: CampaignRow) => void;
  onDelete: (campaign: CampaignRow) => void;
  onDuplicate: (campaign: CampaignRow) => void;
  /** dnd-kit useDraggable 배선(없으면 정적 카드 — DragOverlay/비드래그 컨텍스트용). */
  dragRef?: (element: HTMLElement | null) => void;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  /** 원본 카드가 들려 있는 중(오버레이가 대신 보임) → 흐리게. */
  isDragging?: boolean;
  /** DragOverlay 안에서 렌더되는 들린 카드 → 살짝 떠 보이게. */
  isOverlay?: boolean;
}

// ---------------------------------------------------------------------------
// Urgency color mapping for date range text
// ---------------------------------------------------------------------------

// 심각도 축(P8 §1)에 이미 올바르게 앉아 있던 색을 리터럴이 아니라 --status-* 토큰으로 표현한다.
// 흰 카드 위 text-[10px] 소형 텍스트라 원색이 아니라 어두운 변형을 쓴다 — status-badge.tsx 가
// 12px 배지에 대해 같은 규칙을 이미 명문화했고, mobile-campaign-card 의 마진 숫자도 같은 근거로
// 같은 선택을 했다. 실측: overdue #8F3C3C 7.29(구 red-600 4.83) ·
// imminent #B45309 5.02 — 구 orange-500 은 2.80 으로 AA 미달이었다(교정).
const urgencyTextClass: Record<DateUrgency, string> = {
  overdue: "text-status-urgent-text",
  imminent: "text-status-caution",
  normal: "text-muted-foreground",
  unset: "text-muted-foreground",
};

// StatusBadge(P8 가드레일 2)의 dedicated-tint 짝을 그대로 쓴다 — 각각 DROPPED · SETTLEMENT_WAIT ·
// COMPLETED 와 같은 토큰 쌍이다.
//
// 알파 틴트(bg-status-*/10)가 아니라 **불투명 -bg 토큰**인 이유: 이 배지들은 흰 카드가 아니라
// 아래 `bg-slate-50` 체크리스트 박스 위에 얹힌다. 원색/10 을 slate-50 에 합성하면 caution 이
// 4.47 로 AA(4.5) 미달이 된다(흰 배경에서는 4.65 로 통과 — badge.tsx 의 status-pending 변형이
// 흰 배경 전용인 것과 같은 이유다). P8 §5 "토큰은 표면 종속". 실측(slate-50 박스 위):
// overdue 6.42 · today 4.84 · done 5.21.
//
// upcoming 은 무채색을 유지한다 — 부재가 아니라 "볼 것 없음" 등급 선언이다(P8 §2).
//
// `done` 이 여기 없는 건 누락이 아니다. `campaign-actions` 에서 tone==="done" 은 dueDate==null 과
// **동치**이고(addDays 가 파싱 불가 날짜에 null 을 돌려주므로 dueDate 는 null 이거나 항상 파싱
// 가능한 YMD 다), 이 맵의 유일한 소비처는 `action.dueDate` 가드 뒤다 — 즉 done 배지는 그려질 수
// 없다(전 status × 날짜 조합 완전탐색으로 확인). 죽은 색 매핑을 남겨두면 다음 사람이 "쓰이는
// 색"으로 오인해 그 위에 근거를 쌓는다. 소비처의 `tone !== "done"` 이 이 불변식을 **타입으로**
// 증명한다 — 캐스트가 아니라 좁히기라, 나중에 done 이 정말 렌더되게 바뀌면 컴파일이 깨져서 알려준다.
type RenderableActionTone = Exclude<CampaignActionTone, "done">;

const actionToneClass: Record<RenderableActionTone, string> = {
  overdue: "bg-status-urgent-bg text-status-urgent-text",
  today: "bg-status-caution-bg text-status-caution",
  upcoming: "bg-slate-100 text-slate-700",
};

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17z" />
      <polygon points="10 15 15 12 10 9" />
    </svg>
  );
}

const renderSnsIcon = (snsType?: string) => {
  if (!snsType) return null;
  const type = snsType.toUpperCase();
  if (type === "INSTAGRAM") {
    return <InstagramIcon className="size-3 text-pink-500/70 shrink-0" />;
  }
  if (type === "YOUTUBE") {
    return <YoutubeIcon className="size-3 text-red-500/70 shrink-0" />;
  }
  return <Globe className="size-3 text-slate-400/80 shrink-0" />;
};

// ---------------------------------------------------------------------------
// CampaignCard Component
// ---------------------------------------------------------------------------

/**
 * Campaign card for the StageKanbanBoard.
 *
 * Layout:
 * 1. 셀러명 (truncate, 1줄)
 * 2. 딜명 (truncate, 1줄)
 * 3. SubStageBadge (세부 상태)
 * 4. 기간 정보 ("MM.DD ~ MM.DD" or "일정 미정", urgency color)
 *
 * Supports HTML5 native drag and drop with visual feedback.
 */
export function CampaignCard({
  campaign,
  onOpen,
  onDelete,
  onDuplicate,
  dragRef,
  dragListeners,
  dragAttributes,
  isDragging = false,
  isOverlay = false,
}: CampaignCardProps) {
  const dateRange = formatDateRange(campaign.startDate, campaign.endDate);
  const urgency = getDateUrgency(campaign.endDate);
  const checklistSummary = campaign.checklistSummary;
  const action = getCampaignAction(campaign);
  const needsActualSales =
    (campaign.status === "ACTIVE" || campaign.status === "CLOSED") &&
    campaign.actualSales == null;
  // 세팅 창(D-10) 안의 세팅 대기 카드가 안고 있는 실제 할 일. 창 밖은 아직 할 때가
  // 아니라 묻지 않는다(판정 근거는 `campaign-setup.ts` doc). 채널 미지정이면 등록
  // 판정 자체가 불가능하므로 "채널 지정"이 선행 — 둘은 상호배타지만 순서를 명시한다.
  const inSetupWindow = campaign.status === "PREPARATION" && isInSetupWindow(campaign);
  const needsChannelSetup = inSetupWindow && needsChannelAssignment(campaign);
  const needsOrderSetup = inSetupWindow && needsOrderRegistration(campaign);
  const requiredProgress =
    checklistSummary && checklistSummary.requiredTotalCount > 0
      ? Math.round(
          (checklistSummary.requiredCheckedCount /
            checklistSummary.requiredTotalCount) *
            100,
        )
      : 0;
  const dateLabel =
    campaign.status === "SETTLEMENT_WAIT"
      ? `${dateRange} - 종료 후 대기`
      : dateRange;

  return (
    <div
      ref={dragRef}
      {...dragAttributes}
      {...dragListeners}
      style={dragListeners ? { touchAction: "none" } : undefined}
      className={cn(
        "group relative rounded-2xl border border-slate-200 bg-white shadow-soft-sm transition-[translate,scale,rotate,opacity,box-shadow,border-color] duration-200",
        // 키보드 드래그/열기(role=button·KeyboardSensor) 포커스 링 — 앱 전역 --focus-ring 토큰(WCAG 1.4.11).
        // 카드류는 inset이라 틴트 배경에도 흰 테 아티팩트 없음 + 컬럼 outer 하이라이트와 시각 구분. OutreachCardContent와 동일.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
        dragListeners && "cursor-grab active:cursor-grabbing",
        // 오버레이가 아닐 때만 hover 리프트(들린 복제엔 hover 무의미)
        !isOverlay && "hover:-translate-y-0.5 hover:shadow-soft-md hover:border-primary/15",
        // 원본은 드래그 중 흐리게(오버레이가 실제로 보이는 카드)
        isDragging && "opacity-40",
        // 들린 카드: 살짝 떠서 기울어짐
        isOverlay && "cursor-grabbing rotate-1 scale-[1.02] shadow-soft-lg border-primary/20"
      )}
      onClick={() => onOpen(campaign)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(campaign);
        }
      }}
    >
      <div className="px-2.5 pb-2.5 pt-2.5">
        {/* Header: campaign name with round badge + context menu */}
        <div className="flex min-w-0 items-center justify-between gap-1 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-[12px] font-semibold leading-snug text-foreground">
            {/* 라이브 도트의 초록은 **오너 확정 예외다(2026-07-16) — 토큰으로 정렬하지 말 것.**
                정본의 ACTIVE 는 네이비(--status-active #0A3D62)라 얼핏 "리터럴이 정본에서 갈라진 것"
                처럼 보이지만 아니다: 이 도트가 말하는 건 생애주기 등급이 아니라 **"지금 살아 움직인다"**
                이고, "초록=라이브"는 앱 밖에서 온 관용이다. 네이비로 바꾸면 카드 제목 옆에서 상태 배지와
                같은 색이 되어 도트가 배지의 중복이 된다. 심각도 배지 리터럴 정렬(2026-07-16)에서 이 2줄만
                의도적으로 제외했다 — "일관성"을 이유로 회수하지 말 것. */}
            {campaign.status === "ACTIVE" && (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            )}
            <span className="truncate" title={campaign.dealName}>{campaign.dealName}</span>
            {campaign.snsType && renderSnsIcon(campaign.snsType)}
            <span className="truncate text-muted-foreground max-w-[80px]" title={campaign.sellerName}>
              {campaign.sellerName}
            </span>
            {campaign.roundNumber ? (
              <Badge variant="secondary" size="compact" className="font-semibold bg-slate-100 text-slate-600 border-none shrink-0">
                {campaign.roundNumber}차
              </Badge>
            ) : null}
            {/* CG-1 그룹 배지(ⓓ): 네이비 틴트 + Boxes. 비인터랙티브 인디케이터(카드 전체가 이미 button). */}
            {campaign.groupId != null ? (
              <span
                title={
                  typeof campaign.groupMemberCount === "number"
                    ? `이 셀러의 조합 그룹 · ${campaign.groupMemberCount}건`
                    : "이 셀러의 조합 그룹"
                }
                className={`inline-flex shrink-0 items-center gap-0.5 ${badgeSizeClassName.compact} font-semibold bg-primary/10 text-primary`}
              >
                <Boxes className="size-2.5 shrink-0" aria-hidden="true" />
                {typeof campaign.groupMemberCount === "number"
                  ? campaign.groupMemberCount
                  : null}
                <span className="sr-only">
                  {typeof campaign.groupMemberCount === "number"
                    ? `조합 그룹 ${campaign.groupMemberCount}건 소속`
                    : "조합 그룹 소속"}
                </span>
              </span>
            ) : null}
          </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="-mr-1 shrink-0 rounded-md opacity-0 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="size-3.5" />
                  <span className="sr-only">캠페인 메뉴</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.stopPropagation?.();
                      onDuplicate(campaign);
                    }}
                  >
                    복제
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(e) => {
                      e.stopPropagation?.();
                      onDelete(campaign);
                    }}
                  >
                    삭제
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

        {/* Date range & Channel Badge */}
        <div className="flex items-center gap-1.5 mt-2">
          {/* 채널은 범주라 색을 받지 않는다(P8 색 원칙 4) — 손익 리포트가 이미 쓰는 맨
              outline 배지와 같은 형태다. 이 카드에 남은 색은 전부 판단색(지연·정체·
              최저가 위반·실매출 미입력)이라, 채널색을 걷어내면 그것들이 더 또렷해진다. */}
          <Badge variant="outline" size="compact" className="shrink-0">
            {salesChannelLabels[campaign.salesChannel]}
          </Badge>
          {campaign.hasPriceViolation ? (
            <span title={`최저가 위반 딜 ${campaign.violatedDealCount ?? 0}건`}>
              {/* 리터럴 red → status-urgent 변형. mobile-campaign-card 가 같은 배지에 대해 이미
                  같은 스왑을 마쳐서, 같은 "최저가 위반"이 두 표면에서 다른 빨강이던 상태였다.
                  이 배지는 흰 카드 위라 변형의 알파 틴트(/10 → #F9EEEE)로도 6.42 로 통과한다. */}
              <Badge
                variant="status-urgent"
                size="compact"
                className="shrink-0"
              >
                최저가 위반
              </Badge>
            </span>
          ) : null}
          <span
            className={cn(
              "text-[10px] font-medium flex items-center min-w-0 truncate",
              urgencyTextClass[urgency],
            )}
            title={dateLabel}
          >
            <Calendar className="size-3 mr-1 shrink-0" />
            <span className="truncate">{dateLabel}</span>
          </span>
        </div>
        {checklistSummary ? (
          <div className="mt-2 rounded-lg bg-slate-50 px-2 py-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              {/* `tone !== "done"` 은 런타임 분기가 아니라 **타입 좁히기**다 — done 이면 위 dueDate 가
                  이미 null 이라 어차피 걸린다(둘은 동치). 동작은 그대로고, actionToneClass 가 도달
                  가능한 3개만 갖는 근거를 컴파일러가 검사하게 만든다. */}
              {action.dueDate && action.tone !== "done" ? (
                <span
                  className={cn("shrink-0", badgeSizeClassName.compact, actionToneClass[action.tone])}
                >
                  {action.label} {formatCampaignActionDate(action.dueDate)}
                </span>
              ) : null}
              {/* 세팅 창(D-10) 안의 세팅 대기 카드가 안고 있는 실제 할 일. caution 티어 —
                  status-badge.tsx(가드레일 2)의 SETTLEMENT_WAIT 와 같은 토큰 쌍이고, slate-50
                  체크리스트 박스 위라 알파 틴트가 아니라 불투명 -bg 를 쓴다(위 actionToneClass
                  주석과 같은 근거). 채널 미지정이면 등록 판정 자체가 불가능하므로 채널 지정이 선행 —
                  둘은 상호배타지만 순서를 명시한다. 판정 SSOT·실측 근거는 campaign-setup.ts. */}
              {needsChannelSetup ? (
                <span className={cn("shrink-0", badgeSizeClassName.compact, "text-status-caution bg-status-caution-bg")}>
                  판매채널 지정 필요
                </span>
              ) : needsOrderSetup ? (
                <span className={cn("shrink-0", badgeSizeClassName.compact, "text-status-caution bg-status-caution-bg")}>
                  주문관리 등록 필요
                </span>
              ) : action.isStagnant && action.stagnantDays ? (
                /* 정체 = 같은 caution 티어. 일정 앵커가 없는 단계(PROPOSAL 등)에만 남은 약한
                   신호다 — 세팅 대기(PREPARATION)는 campaign-actions 가 Infinity 라 발화하지 않는다. */
                <span className={cn("shrink-0", badgeSizeClassName.compact, "text-status-caution bg-status-caution-bg")}>
                  정체 {action.stagnantDays}일
                </span>
              ) : null}
              {/* indigo 는 globals.css 에 없는 hue 였다(가드레일 2 가 막는 신규 hue 부채). 오너 결정
                  2026-07-16: --status-info 로 이관 — "진행 중/할 일 남음"이라 StatusBadge 의
                  SETTLEMENT_IN_PROGRESS 와 같은 계열이고, 쿨 계열이라 정체(앰버)와 계속 구분된다.
                  slate-50 박스 위 합성 #E7ECF0 에서 4.75 로 AA 통과(구 indigo 7.07 → 대비는 낮아지되
                  기준은 충족). info 는 전용 -bg 가 없어 알파 틴트를 쓰는 유일한 자리다. */}
              {needsActualSales ? (
                <span className={cn("shrink-0", badgeSizeClassName.compact, "text-status-info bg-status-info/10")}>
                  실매출 미입력
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10px] font-medium text-foreground text-right">
                  {checklistSummary.nextItemLabel ?? "현재 단계 체크 완료"}
                </div>
              </div>
            </div>
            
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 h-1 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-slate-900 transition-[width]"
                  style={{ width: `${requiredProgress}%` }}
                />
              </div>
              <div className="shrink-0 flex items-center gap-1 text-[10px]">
                <span className="text-muted-foreground">
                  체크 {checklistSummary.checkedCount}/{checklistSummary.totalCount}
                </span>
                <span className="font-semibold text-foreground">
                  {requiredProgress}%
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
