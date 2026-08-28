export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * "7월 1일 (수)" — 모바일 시트의 일정·정산 행 날짜 표기.
 *
 * `T00:00:00` 을 붙여 로컬 자정으로 파싱한다. 날짜만 있는 ISO 문자열("2026-07-01")은
 * UTC 자정으로 해석되므로 KST 에서 그냥 파싱하면 하루 앞의 요일이 나온다.
 * null 은 표기 문구가 표면마다 달라 호출자가 처리한다.
 */
export function formatDateWithWeekday(iso: string): string {
  const ymd = iso.slice(0, 10);
  const [, m, d] = ymd.split("-").map(Number);
  const weekday = WEEKDAY_LABELS[new Date(`${ymd}T00:00:00`).getDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

export function formatCurrency(value: number | null | undefined) {
  if (value == null) return "-";
  return new Intl.NumberFormat("ko-KR", {
    style: "decimal",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number | null | undefined) {
  if (value == null) return "-";
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatRate(value: number | null | undefined) {
  if (value == null) return "-";
  return `${value.toFixed(1)}%`;
}

export function formatBytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatBusinessNumber(value?: string | null): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 3) {
    return digits;
  } else if (digits.length <= 5) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  } else {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 10)}`;
  }
}


/**
 * "방금 / N시간 전 / N일 전 / 26-07-01" — 저장된 초안이 언제 것인지.
 *
 * ⚠️ **`now` 를 인자로 받는 이유는 테스트다.** 시스템 시각에만 의존하면 고정 날짜
 * 픽스처를 쓴 테스트가 어느 날 갑자기 깨진다(P9 「시각 의존 테스트 시한폭탄」 —
 * 이 레포에서 실제로 main 이 하루 막힌 적이 있다). 호출부는 인자를 생략한다.
 *
 * 7일 이상이면 상대 표기를 버리고 날짜를 쓴다 — "37일 전"은 사람이 못 센다.
 */
export function formatRelativeSavedAt(
  iso: string,
  now: Date = new Date(),
): string {
  const saved = new Date(iso);
  const diffMs = now.getTime() - saved.getTime();
  if (!Number.isFinite(diffMs)) return formatDate(iso);
  // 미래 시각(시계 오차·서버 시차)은 "방금"으로 접는다 — "-1시간 전"은 버그로 읽힌다.
  if (diffMs < 60 * 60 * 1000) return "방금";
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return formatDate(iso);
}
