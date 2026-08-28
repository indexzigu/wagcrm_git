// ---------------------------------------------------------------------------
// Date utility functions for Campaign Card date range display
// ---------------------------------------------------------------------------

/**
 * Urgency classification for campaign end dates.
 * - overdue: end date is before today
 * - imminent: end date is within 3 days from today (inclusive)
 * - normal: end date is more than 3 days from today
 * - unset: start or end date is not set
 */
export type DateUrgency = "overdue" | "imminent" | "normal" | "unset";

/**
 * Formats a date range as "MM.DD ~ MM.DD".
 * If either startDate or endDate is null, undefined, or empty string,
 * returns "일정 미정".
 *
 * @param startDate - ISO date string (e.g. "2024-03-15") or null/undefined/empty
 * @param endDate - ISO date string (e.g. "2024-04-20") or null/undefined/empty
 * @returns Formatted date range string or "일정 미정"
 */
export function formatDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  if (!startDate || !endDate) {
    return "일정 미정";
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Check for invalid dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return "일정 미정";
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit'
  });

  const formatParts = (d: Date) => {
    const parts = formatter.formatToParts(d);
    const m = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    return `${m}.${day}`;
  };

  return `${formatParts(start)} ~ ${formatParts(end)}`;
}

/**
 * Classifies the urgency of a campaign based on its end date.
 *
 * - "overdue": endDate < today (end date has passed)
 * - "imminent": endDate is within 3 days from today (0 <= diff <= 3 days)
 * - "normal": endDate is more than 3 days from today
 * - "unset": endDate is null, undefined, or empty string
 *
 * @param endDate - ISO date string or null/undefined/empty
 * @param today - Optional reference date for testing (defaults to current date)
 * @returns DateUrgency classification
 */
/**
 * KST 달력 날짜(`YYYY-MM-DD`) — 이 레포의 "며칠인가" 판정이 공유하는 표기 SSOT.
 *
 * 의존성이 없어 **client-safe** 하다는 것이 이 자리에 있는 이유다.
 * `campaign-row.toKstDateStr`(null·NaN 처리 포함)이 이 함수에 위임하고,
 * `settlement-stage.ts` 의 지연 경계도 같은 문자열로 비교한다 — 서버는 `Date`,
 * 모바일은 이미 ymd 문자열로 읽고 있어서, 한쪽만 시각까지 비교하면 **같은 건이
 * 두 화면에서 하루 어긋난다**(실제로 어긋나 있었다 — T-062 실측).
 *
 * ⚠️ `campaign-row` 를 import 해서 재사용하지 말 것 — 그 모듈은 `./encryption`
 * (node crypto)을 끌고 와 클라이언트 번들에서 터진다.
 */
export function toKstYmd(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

export function getDateUrgency(
  endDate: string | null | undefined,
  today?: Date,
): DateUrgency {
  if (!endDate) {
    return "unset";
  }

  const end = new Date(endDate);
  if (isNaN(end.getTime())) {
    return "unset";
  }

  const reference = today ?? new Date();

  // Normalize both dates to start of day in KST
  const endStr = toKstYmd(end);
  const refStr = toKstYmd(reference);

  const endDay = new Date(endStr);
  const todayDay = new Date(refStr);

  const diffMs = endDay.getTime() - todayDay.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays < 0) {
    return "overdue";
  }

  if (diffDays <= 3) {
    return "imminent";
  }

  return "normal";
}
