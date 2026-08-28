export type FollowUpType =
  | "1ST_REMINDER"
  | "2ND_REMINDER"
  | "SAMPLE_CHECK"
  | "MANUAL_REMINDER";

export interface FollowUpBadgeColor {
  bg: string;
  text: string;
  border: string;
}

export interface FollowUpAction {
  type: FollowUpType;
  label: string;
  badgeColor: FollowUpBadgeColor;
  elapsedDays: number;
}

export interface SalesTaskFollowUpInput {
  status: string;
  proposalSentAt?: string | Date | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
  nextReminderAt?: string | Date | null;
}

/**
 * 두 날짜 객체를 연, 월, 일 단위의 자정(Local) 기준으로 정규화하여 경과 일수를 계산합니다.
 */
export function getDaysDiff(from: Date, to: Date): number {
  const fromZero = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toZero = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  const diffMs = toZero.getTime() - fromZero.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function parseDate(val: string | Date | null | undefined): Date | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// 팔로업 리마인드 배지 색 — 종류(1차/2차/샘플/지정일)별 색 구분 없이 단일 info 톤.
// 소유자 승인(2026-07-09) + 모바일 40dfd56과 동일 방침: 리마인드 종류는 아이콘/라벨로 구분하고
// 색은 정보성 단일 톤으로 통일한다(무지개 방지, Quality Gate "색=의미"). 서비스 팔레트 status-info
// (#4A6B82) tint 사용 — action-badge의 10px 텍스트도 대비 4.94(AA) 충족. globals.css @theme 참조.
const INFO_BADGE_COLOR: FollowUpBadgeColor = {
  bg: "bg-status-info/10",
  text: "text-status-info",
  border: "border-status-info/20",
};

const BADGE_COLORS: Record<FollowUpType, FollowUpBadgeColor> = {
  "1ST_REMINDER": INFO_BADGE_COLOR,
  "2ND_REMINDER": INFO_BADGE_COLOR,
  "SAMPLE_CHECK": INFO_BADGE_COLOR,
  "MANUAL_REMINDER": INFO_BADGE_COLOR,
};

/**
 * SalesTask의 현재 상태와 날짜 정보를 바탕으로 권장 팔로업 액션을 판단합니다.
 *
 * @param task SalesTask 입력 정보
 * @param referenceDate 기준 시각 (기본값: 현재 시각)
 * @returns 권장 팔로업 정보 또는 null (매칭되는 액션이 없는 경우)
 */
export function calculateFollowUp(
  task: SalesTaskFollowUpInput,
  referenceDate?: Date,
): FollowUpAction | null {
  const now = referenceDate ?? new Date();

  // 1. 우선순위 룰: 사용자가 직접 차기 리마인더 일시(nextReminderAt)를 명시적으로 설정한 경우
  const nextReminder = parseDate(task.nextReminderAt);
  if (nextReminder) {
    const diff = getDaysDiff(nextReminder, now);
    // 지정된 예정일이 되었거나 이미 지난 경우
    if (diff >= 0) {
      return {
        type: "MANUAL_REMINDER",
        label: "지정일 팔로업 필요",
        badgeColor: BADGE_COLORS.MANUAL_REMINDER,
        elapsedDays: diff,
      };
    }
    return null;
  }

  // 2. 자동 계산 룰
  const status = task.status;

  if (status === "PROPOSED") {
    const proposalSent = parseDate(task.proposalSentAt) ?? parseDate(task.createdAt);
    if (!proposalSent) return null;

    const diff = getDaysDiff(proposalSent, now);
    if (diff >= 28) {
      return {
        type: "2ND_REMINDER",
        label: "2차 리마인드 권장",
        badgeColor: BADGE_COLORS["2ND_REMINDER"],
        elapsedDays: diff,
      };
    } else if (diff >= 14) {
      return {
        type: "1ST_REMINDER",
        label: "1차 리마인드 권장",
        badgeColor: BADGE_COLORS["1ST_REMINDER"],
        elapsedDays: diff,
      };
    }
  } else if (status === "TESTING" || status === "SAMPLE_TESTING") {
    const baseDate = parseDate(task.updatedAt) ?? parseDate(task.createdAt);
    if (!baseDate) return null;

    const diff = getDaysDiff(baseDate, now);
    if (diff >= 14) {
      return {
        type: "SAMPLE_CHECK",
        label: "샘플 진행상황 체크 요망",
        badgeColor: BADGE_COLORS.SAMPLE_CHECK,
        elapsedDays: diff,
      };
    }
  }

  return null;
}
