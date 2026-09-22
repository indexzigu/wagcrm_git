/**
 * 결재함 기록 표면(조회 결과 카드·봇 활동 표)의 시각 표기 SSOT — `MM-DD HH:mm`.
 *
 * 두 표면이 같은 목록 안에서 위아래로 읽히므로 자리수가 흔들리면 안 된다
 * (`tabular-nums` 와 짝이다). 연도는 넣지 않는다 — 여기 쌓이는 것은 최근 기록이고,
 * 연도까지 붙이면 한 줄에서 가장 긴 덩어리가 되어 제목을 밀어낸다.
 *
 * ⚠️ 타임존을 고정한다. 서버·CI·브라우저의 TZ 가 제각각이라 고정하지 않으면 같은
 * 행이 환경마다 다른 시각으로 보인다(운영자는 KST 로 판단한다).
 */
const FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = FORMATTER.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}
