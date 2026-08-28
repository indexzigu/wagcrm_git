"use client";

import { AlertCircleIcon, CheckCircle2Icon, Clock3Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { getDealIdentityParts } from "@/lib/deal-display";
import type { OutreachRow } from "@/components/crm/outreach-list";
import type { OutreachStatus } from "@/lib/validations/outreach";
import { ActionBadge } from "@/components/crm/action-badge";
import { calculateFollowUp } from "@/lib/followup-engine";
import { MobileTopBar } from "./mobile-top-bar";

type MobileOutreachViewProps = {
  tasks: OutreachRow[];
  loading: boolean;
  onSelectTask: (task: OutreachRow) => void;
  onReminderSent: (taskId: string) => Promise<void>;
  onCreateCampaign: (taskId: string) => Promise<void>;
  onStatusChange: (taskId: string, status: OutreachStatus) => Promise<void>;
};



function daysSince(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function isReminderDue(task: OutreachRow) {
  if (task.status !== "PROPOSED" || !task.nextReminderAt) return false;
  return new Date(task.nextReminderAt).getTime() <= Date.now();
}



function MobileOutreachCard({
  task,
  action,
  onSelectTask,
  onReminderSent,
  onCreateCampaign,
  onStatusChange,
}: {
  task: OutreachRow;
  action: "reminder" | "approval" | "response";
  onSelectTask: (task: OutreachRow) => void;
  onReminderSent: (taskId: string) => Promise<void>;
  onCreateCampaign: (taskId: string) => Promise<void>;
  onStatusChange: (taskId: string, status: OutreachStatus) => Promise<void>;
}) {
  const elapsedDays = daysSince(task.updatedAt ?? task.proposedAt);
  const elapsedLabel = elapsedDays == null ? "경과일 미확인" : `${elapsedDays}일째`;

  // 경과일 색 — 단일 에스컬레이션 램프(무채색→주의→위험). 락 팔레트 정합(소유자 승인 2026-07-09):
  // 지연 심각도 1개 의미축만 색으로, 종결 상태(전환·드랍)는 무채색. violet/orange/rose/amber 다색 제거.
  const isTerminalStatus = task.status === "CONVERTED" || task.status === "DROPPED";
  let elapsedClassName = "text-muted-foreground";
  if (!isTerminalStatus && elapsedDays != null && elapsedDays >= 7) {
    // #8F3C3C(--status-urgent-text): 11px 텍스트가 카드/틴트 배경 위에서도 AA(≥4.5:1) 확보.
    // 기본 --status-urgent(#BF5050)은 흰 배경에서 ~4.5:1 경계라 소형 텍스트엔 -text 변형 사용.
    elapsedClassName = "text-status-urgent-text font-semibold";
  } else if (!isTerminalStatus && elapsedDays != null && elapsedDays >= 3) {
    elapsedClassName = "text-status-caution font-semibold";
  }

  // 메모 내용 가져오기 (JSON 파싱 포함 안전장치)
  const getMemoText = () => {
    let rawMemo = null;
    if (task.status === "NEGOTIATION" && task.negotiationMemo) rawMemo = task.negotiationMemo;
    else if (task.status === "TESTING" && task.testingMemo) rawMemo = task.testingMemo;
    else if (task.status === "PROPOSED" && task.proposalMessage) rawMemo = task.proposalMessage;
    else if ((task.status === "PENDING_APPROVAL" || task.status === "CONVERTED") && task.negotiationMemo)
      rawMemo = task.negotiationMemo;
    else if (task.status === "DROPPED" && task.dropReason) rawMemo = task.dropReason;

    if (!rawMemo) return null;
    try {
      const parsed = JSON.parse(rawMemo);
      return typeof parsed === "object" ? parsed.memoText || rawMemo : rawMemo;
    } catch {
      return rawMemo;
    }
  };

  const memo = getMemoText();
  const followUp = calculateFollowUp(task);

  // 후속 필요 카드 = 단일 info 액센트(좌측 보더). 리마인드 종류(수동/1차/2차)는 색으로 구분하지
  // 않는다 — 무지개 제거(amber·blue 삭제), 심각도는 위 경과일 텍스트 램프가 담당(소유자 승인 2026-07-09).
  // 기본 카드는 다른 탭과 같은 유리 문법. followUp 액센트는 의미를 담은 상태 표시라
  // 그대로 둔다 — 유리로 덮으면 "후속 필요"가 안 읽힌다.
  let cardBorder = "border-white/60 bg-white/85 backdrop-blur-sm";
  if (followUp) {
    cardBorder = "border-status-info/20 bg-status-info/[0.06] border-l-4 border-l-status-info";
  }

  return (
    <article className={`rounded-2xl border p-3.5 shadow-soft-sm transition-colors ${cardBorder}`}>
      <button
        type="button"
        onClick={() => onSelectTask(task)}
        // 프레스 틴트 — 네거티브 마진으로 시각 레이아웃은 그대로 두고 탭 피드백 면적만 확보.
        // 카드 전체가 아니라 이 영역만 탭 대상이라(하단 액션 버튼 별도) scale 대신 행 틴트를 쓴다.
        className="-m-1.5 flex w-full flex-col gap-2 rounded-xl p-1.5 text-left transition-colors duration-150 active:bg-slate-900/[0.04]"
      >
        {/* 1행: 셀러이름 | 딜명 (브랜드명) */}
        <div className="flex items-center justify-between gap-2 min-w-0 w-full">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <SellerIdentityInfo
              sellerName={task.sellerName}
              snsType={task.snsType}
              snsHandle={task.snsHandle}
              variant="compact"
              hideSns={true}
            />
            <ActionBadge task={task} />
          </div>
          <EntityIdentity
            parts={getDealIdentityParts({
              dealName: task.dealName,
              brandName: task.brandName,
              partnerName: task.partnerName,
            })}
            variant="compact"
            className="max-w-[50%] shrink-0"
          />
        </div>

        {/* 2행: 협의 수수료 (협의중 단계부터) 및 경과일 표기 */}
        {task.status !== "PROPOSED" ? (
          <div className="mt-1 flex items-center justify-between gap-2 min-w-0 w-full">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>총수수료 <span className="font-semibold text-muted-foreground">{task.totalMarginRate}%</span></span>
              <span className="text-border/60">·</span>
              <span>협의수수료 <span className="font-semibold text-muted-foreground">{task.sellerMarginRate}%</span></span>
            </div>
            <span className={`shrink-0 text-[11px] font-medium ${elapsedClassName}`}>
              {elapsedLabel}
            </span>
          </div>
        ) : null}

        {/* 3행: 메모 & 경과일 (제안중 단계용 스마트 요약 및 경과일 배치) */}
        {task.status === "PROPOSED" ? (
          <div className="mt-1 flex items-center justify-between gap-3 text-[11px] w-full">
            {memo ? (
              <div className="rounded-md bg-muted border border-border px-2 py-0.5 text-muted-foreground truncate flex-1 max-w-[75%]">
                {memo}
              </div>
            ) : (
              <div className="flex-1" />
            )}
            <span className={`shrink-0 font-medium ${elapsedClassName}`}>
              {elapsedLabel}
            </span>
          </div>
        ) : (
          <>
            {memo && (
              <div className="mt-1.5 w-full rounded-md bg-muted border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground line-clamp-1 leading-relaxed">
                {memo}
              </div>
            )}
          </>
        )}
      </button>

      <div className="mt-3 flex gap-2">
        {action === "reminder" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 flex-1 rounded-xl"
            onClick={() => void onReminderSent(task.id)}
          >
            리마인드 완료
          </Button>
        ) : null}
        {action === "approval" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 flex-1 rounded-xl"
            onClick={() => void onCreateCampaign(task.id)}
          >
            캠페인 전환
          </Button>
        ) : null}
        {action === "response" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 flex-1 rounded-xl"
            onClick={() => void onStatusChange(task.id, "NEGOTIATION")}
          >
            협의중으로 이동
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 flex-1 rounded-xl"
          onClick={() => onSelectTask(task)}
        >
          메모 확인
        </Button>
      </div>
    </article>
  );
}

export function MobileOutreachView({
  tasks,
  loading,
  onSelectTask,
  onReminderSent,
  onCreateCampaign,
  onStatusChange,
}: MobileOutreachViewProps) {
  const reminderDueTasks = tasks
    .filter(isReminderDue)
    .sort((left, right) => (left.nextReminderAt ?? "").localeCompare(right.nextReminderAt ?? ""))
    .slice(0, 5);
  const pendingApprovalTasks = tasks
    .filter((task) => task.status === "PENDING_APPROVAL")
    .sort((left, right) => (left.updatedAt ?? left.proposedAt).localeCompare(right.updatedAt ?? right.proposedAt))
    .slice(0, 5);
  const responseGapTasks = tasks
    .filter((task) => {
      if (task.status !== "PROPOSED" && task.status !== "NEGOTIATION" && task.status !== "TESTING") {
        return false;
      }
      const elapsed = daysSince(task.updatedAt ?? task.proposedAt);
      return elapsed != null && elapsed >= 3;
    })
    .filter((task) => !reminderDueTasks.some((reminderTask) => reminderTask.id === task.id))
    .slice(0, 5);
  const visibleCount = reminderDueTasks.length + pendingApprovalTasks.length + responseGapTasks.length;

  if (loading) {
    return (
      <section className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 px-5 pb-24 animate-pulse">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3.5 w-48" />
          </div>
          <Skeleton className="h-5 w-10 rounded-full" />
        </div>
        <div className="flex flex-col gap-5 border border-white/60 bg-white/85 backdrop-blur-sm rounded-2xl p-5 shadow-soft-sm">
          <div className="pb-3 border-b border-slate-100">
            <Skeleton className="h-5 w-32 mb-2" />
            <Skeleton className="h-3 w-48" />
          </div>
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="border border-white/60 bg-white/85 backdrop-blur-sm rounded-xl p-4 shadow-soft-sm space-y-3">
                <div className="flex justify-between items-start">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-12" />
                </div>
                <Skeleton className="h-3 w-36" />
                <div className="flex justify-between items-center pt-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-14 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 px-5 pb-24">
      <MobileTopBar
        title="영업 확인"
        right={
          <Badge variant={visibleCount > 0 ? "status-pending" : "secondary"} className="shrink-0">
            {visibleCount > 0 ? `${visibleCount}건` : "안정"}
          </Badge>
        }
      >
        <p className="mt-0.5 text-xs text-muted-foreground">
          제안 보드가 아니라 응답·리마인드·전환 판단만 봅니다.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>리마인드 {reminderDueTasks.length}건</span>
          <span>전환 대기 {pendingApprovalTasks.length}건</span>
          <span>응답 공백 {responseGapTasks.length}건</span>
        </div>
      </MobileTopBar>

      {visibleCount === 0 ? (
        <Empty className="border border-border/70 bg-background py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2Icon />
            </EmptyMedia>
            <EmptyTitle>지금 확인할 영업 큐가 없습니다.</EmptyTitle>
            <EmptyDescription>리마인드나 전환 판단이 필요한 항목이 생기면 표시됩니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {reminderDueTasks.length > 0 ? (
        <section className="mobile-briefing-section flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Clock3Icon className="size-4 text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold text-foreground">리마인드 기한</h2>
              <p className="text-xs text-muted-foreground">다음 연락 여부를 판단해야 하는 제안입니다.</p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {reminderDueTasks.map((task) => (
              <MobileOutreachCard
                key={task.id}
                task={task}
                action="reminder"
                onSelectTask={onSelectTask}
                onReminderSent={onReminderSent}
                onCreateCampaign={onCreateCampaign}
                onStatusChange={onStatusChange}
              />
            ))}
          </div>
        </section>
      ) : null}

      {pendingApprovalTasks.length > 0 ? (
        <section className="mobile-briefing-section flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">캠페인 전환 대기</h2>
            <p className="text-xs text-muted-foreground">조건이 정리되어 운영 캠페인으로 넘길 후보입니다.</p>
          </div>
          <div className="flex flex-col gap-3">
            {pendingApprovalTasks.map((task) => (
              <MobileOutreachCard
                key={task.id}
                task={task}
                action="approval"
                onSelectTask={onSelectTask}
                onReminderSent={onReminderSent}
                onCreateCampaign={onCreateCampaign}
                onStatusChange={onStatusChange}
              />
            ))}
          </div>
        </section>
      ) : null}

      {responseGapTasks.length > 0 ? (
        <section className="mobile-briefing-section flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <AlertCircleIcon className="size-4 text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold text-foreground">응답 공백</h2>
              <p className="text-xs text-muted-foreground">상태가 멈춘 영업 항목입니다.</p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {responseGapTasks.map((task) => (
              <MobileOutreachCard
                key={task.id}
                task={task}
                action="response"
                onSelectTask={onSelectTask}
                onReminderSent={onReminderSent}
                onCreateCampaign={onCreateCampaign}
                onStatusChange={onStatusChange}
              />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
