/**
 * Reminder Engine — 캠페인 마감일 기반 알림 스케줄 계산 모듈
 *
 * 순수 함수로 구현되어 서버사이드에서 endDate 변경 시 호출된다.
 * D-7, D-3, D-1, D-Day 오프셋으로 리마인더 스케줄을 생성하며,
 * 이미 지난 날짜의 리마인더는 생성하지 않는다.
 */

export type ReminderType = "D_MINUS_7" | "D_MINUS_3" | "D_MINUS_1" | "D_DAY";

export type ReminderStatus = "PENDING" | "FIRED" | "CANCELLED";

export type ReminderSchedule = {
  id: string;
  campaignId: string;
  scheduledAt: string; // ISO datetime (YYYY-MM-DD)
  type: ReminderType;
  status: ReminderStatus;
};

/** Offset days before endDate for each reminder type */
const REMINDER_OFFSETS: { type: ReminderType; offsetDays: number }[] = [
  { type: "D_MINUS_7", offsetDays: 7 },
  { type: "D_MINUS_3", offsetDays: 3 },
  { type: "D_MINUS_1", offsetDays: 1 },
  { type: "D_DAY", offsetDays: 0 },
];

/**
 * Parse a date string (YYYY-MM-DD or ISO) to a Date at midnight local time.
 */
function parseDate(value: string): Date {
  const dateStr = value.slice(0, 10);
  return new Date(`${dateStr}T00:00:00`);
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Subtract days from a date and return a new Date.
 */
function subtractDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() - days);
  return result;
}

/**
 * 새 endDate 기반으로 리마인더 스케줄을 재계산한다.
 *
 * - endDate가 과거(currentDate 이전)이면 빈 배열 반환 (모든 리마인더 취소 상태)
 * - endDate가 미래이면 D-7, D-3, D-1, D-Day 스케줄 생성
 * - 이미 지난 날짜(currentDate 이전)의 리마인더는 생성하지 않음
 *
 * @param campaignId - 캠페인 ID
 * @param newEndDate - 새 마감일 (YYYY-MM-DD 또는 ISO string)
 * @param currentDate - 현재 날짜 (테스트용 주입 가능, 기본값: 오늘)
 * @returns 새로 생성된 PENDING 상태의 리마인더 스케줄 배열
 */
export function recalculateReminders(
  campaignId: string,
  newEndDate: string,
  currentDate?: string,
): ReminderSchedule[] {
  const endDate = parseDate(newEndDate);
  const now = currentDate ? parseDate(currentDate) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");

  // If endDate is in the past (strictly before current date), return empty array
  if (endDate < now) {
    return [];
  }

  const schedules: ReminderSchedule[] = [];

  for (const { type, offsetDays } of REMINDER_OFFSETS) {
    const scheduledDate = subtractDays(endDate, offsetDays);

    // Only generate schedules for dates that are today or in the future
    if (scheduledDate >= now) {
      schedules.push({
        id: crypto.randomUUID(),
        campaignId,
        scheduledAt: formatDate(scheduledDate),
        type,
        status: "PENDING",
      });
    }
  }

  return schedules;
}

/**
 * 기존 리마인더 중 PENDING 상태인 것만 CANCELLED로 변경한다.
 * FIRED 상태의 리마인더는 변경하지 않는다.
 *
 * @param reminders - 기존 리마인더 배열
 * @returns PENDING → CANCELLED로 변경된 새 배열 (원본 불변)
 */
export function invalidatePendingReminders(
  reminders: ReminderSchedule[],
): ReminderSchedule[] {
  return reminders.map((reminder) =>
    reminder.status === "PENDING"
      ? { ...reminder, status: "CANCELLED" as const }
      : reminder,
  );
}
