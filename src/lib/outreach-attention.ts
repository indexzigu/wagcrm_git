/**
 * 영업 태스크 「오늘 할 일」 판정 — PC 영업 관리 상단 줄과 모바일 영업 확인 화면이
 * **같은 기준**으로 세도록 한 곳에 둔다(T-226, 오너 결정 2026-10-05).
 *
 * ⛔ 각 화면에서 조건을 다시 쓰지 말 것 — 한쪽만 고치면 PC 와 모바일의 「리마인드 N건」이
 * 다른 숫자가 된다. 단계별 개수(제안중·협의중…)는 이 모듈의 관심사가 아니다: 그건 칸반
 * 열 머리와 진행중/종료됨 탭이 이미 보여준다.
 */

/** 판정에 필요한 필드만 — 화면 행 타입(OutreachRow)에 묶지 않는다. */
type AttentionTask = {
  status: string;
  proposedAt: string;
  updatedAt?: string | null;
  nextReminderAt?: string | null;
};

export type OutreachAttentionKind = "REMINDER_DUE" | "PENDING_APPROVAL" | "RESPONSE_GAP";

/** 마지막 움직임 후 이 일수가 지나면 「응답 공백」이다(모바일 경과일 램프의 주의 문턱과 같다). */
export const RESPONSE_GAP_DAYS = 3;

const AWAITING_RESPONSE_STATUSES = new Set(["PROPOSED", "NEGOTIATION", "TESTING"]);

/** 달력 날짜 기준 경과일(시각 무시). 날짜를 못 읽으면 null — 0일로 접지 않는다. */
export function daysSince(value: string | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** 제안 단계에서 다음 리마인드 시각이 지났다. */
export function isReminderDue(task: AttentionTask, now: Date = new Date()): boolean {
  if (task.status !== "PROPOSED" || !task.nextReminderAt) return false;
  return new Date(task.nextReminderAt).getTime() <= now.getTime();
}

/** 캠페인 전환 승인 대기. */
export function isPendingApproval(task: AttentionTask): boolean {
  return task.status === "PENDING_APPROVAL";
}

/**
 * 진행 중(제안·협의·테스트)인데 마지막 움직임 후 {@link RESPONSE_GAP_DAYS}일 이상 조용하다.
 * 리마인드 기한과의 중복 제거는 하지 않는다 — 화면이 「리마인드」와 함께 셀 때 뺀다.
 */
export function isAwaitingResponse(task: AttentionTask, now: Date = new Date()): boolean {
  if (!AWAITING_RESPONSE_STATUSES.has(task.status)) return false;
  const elapsed = daysSince(task.updatedAt ?? task.proposedAt, now);
  return elapsed != null && elapsed >= RESPONSE_GAP_DAYS;
}

/**
 * 「오늘 할 일」 한 종류에 속하는가. 응답 공백은 리마인드 기한 건을 뺀다 — 한 태스크가
 * 두 숫자에 겹쳐 세이면 합계가 실제 할 일보다 커진다(모바일 목록과 같은 규칙).
 */
export function matchesAttention(
  task: AttentionTask,
  kind: OutreachAttentionKind,
  now: Date = new Date(),
): boolean {
  switch (kind) {
    case "REMINDER_DUE":
      return isReminderDue(task, now);
    case "PENDING_APPROVAL":
      return isPendingApproval(task);
    case "RESPONSE_GAP":
      return isAwaitingResponse(task, now) && !isReminderDue(task, now);
  }
}
