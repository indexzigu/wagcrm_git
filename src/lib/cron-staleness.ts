// 크론 "지연" 판정 SSOT — 마지막 실행이 **한 회차를 통째로 걸렀는가**를 본다.
//
// 왜 생겼나(2026-08-04): `capture-stories` 를 오너 맥의 로컬 레인으로 옮기면서 새 무음 실패
// 경로가 생겼다 — **맥이 꺼져 있으면 러너가 아예 안 돌고, 그때 레이더는 마지막 성공 상태
// (초록)를 유지한 채 시각만 낡는다.** 서버 레인은 플랫폼이 발화를 보장해 "안 돌았다"가
// 드물지만, 로컬 레인은 그게 상시 가능하다. 상태값(SUCCESS/ERROR)은 **마지막 실행이 어땠는가**
// 만 말하고 **그 실행이 언제였어야 하는가**는 말하지 않는다 — 그 공백이 여기 산다.
//
// ⚠️ **오탐이 최대 위험이다.** 매일 빨강이 되면 습관화로 신호를 잃는다(P6·P7 이 반복 경고하는
// 실패 모드이자, 이 잡의 실패 판정을 "전 핸들 실패"로 좁게 잡은 것과 같은 이유). 그래서
// ①유예를 두고 ②주기별로 다르게 재고 ③모르면 판정하지 않는다.

/** 판정에 필요한 최소 형태 — `KNOWN_JOBS` 항목이 그대로 들어맞는다(전체를 요구하지 않아 테스트가 가볍다). */
export type OverdueJobSpec = { cycle: string };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * 주기별 유예. 크론 발화가 몇 분~수십 분 밀리는 것(GitHub 스케줄 크론)과 로컬 러너가 맥이
 * 잠들어 조금 늦게 깨는 것을 흡수한다. 유예를 없애면 정상 운영이 매일 잠깐씩 빨강이 된다.
 */
export const STALE_GRACE_MS = {
  매일: 6 * HOUR,
  매주: 24 * HOUR,
} as const;

/** 표기(`cycle`)에서 기대 간격과 유예를 읽는다. 해석 불가면 null — 모르면 판정하지 않는다. */
function resolveCadence(cycle: string): { intervalMs: number; graceMs: number } | null {
  const trimmed = cycle.trim();
  if (trimmed === "매일") return { intervalMs: DAY, graceMs: STALE_GRACE_MS.매일 };
  // "매주 월"처럼 요일이 붙는다 — 요일 자체는 판정에 쓰지 않는다(간격만 본다).
  if (trimmed.startsWith("매주")) return { intervalMs: 7 * DAY, graceMs: STALE_GRACE_MS.매주 };
  return null;
}

/**
 * 이 잡이 한 회차를 걸렀는가.
 *
 * `lastRunAt` 이 없으면 **지연이 아니다** — 레이더가 이미 "기록 없음"으로 말하고 있고,
 * 여기서 또 지연으로 승격하면 같은 사실이 두 캐리어에 중복된다.
 */
export function isJobOverdue(
  job: OverdueJobSpec,
  lastRunAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastRunAt) return false;
  const cadence = resolveCadence(job.cycle);
  if (!cadence) return false;

  const last = lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
  const elapsed = now.getTime() - last.getTime();
  // 미래 시각(시계 오차·타임존 사고)은 지연이 아니다 — 음수 경과를 지연으로 읽지 않게 방어.
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;

  return elapsed > cadence.intervalMs + cadence.graceMs;
}

/**
 * 지연일 때 사람이 읽을 사유. 지연이 아니면 null 이라 호출부가 분기 없이 쓸 수 있다.
 * "지연"만 띄우는 것보다 **얼마나 밀렸는가**가 판단에 쓸모 있다(맥을 껐던 기간과 대조 가능).
 * ⚠️ UI 문구이므로 em-dash 를 쓰지 않는다(styleseed 기계 점검 1).
 */
export function overdueSummary(
  job: OverdueJobSpec,
  lastRunAt: Date | string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!isJobOverdue(job, lastRunAt, now)) return null;
  const last = lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt!);
  const days = Math.floor((now.getTime() - last.getTime()) / DAY);
  return days >= 1 ? `${days}일째 실행 기록이 없습니다` : "예정 회차를 걸렀습니다";
}
