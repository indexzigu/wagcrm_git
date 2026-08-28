/**
 * dead-man 판정 — 순수 함수. Worker 런타임에 의존하지 않아 vitest 로 직접 검증한다
 * (KV·fetch 를 목킹한 테스트는 판정을 검증하지 못한다).
 *
 * 설계 정본: docs/private/specs/2026-08-19-external-alert-channel-design.md
 *
 * 조건이 **둘**인 것이 이 판정의 중심이다. 경과만 쓰면 Cron Trigger 가 몇 회 밀렸다가
 * 한꺼번에 돌 때 정상 상황을 침묵으로 읽고, 횟수만 쓰면 신고 간격이 바뀔 때 의미가
 * 달라진다. ⛔ 둘 중 하나만 쓰는 것으로 "단순화" 하지 말 것.
 */

/** 침묵으로 판정하기까지의 경과(분) — 실질 게이트. 재부팅·OS 업데이트를 흡수한다. */
export const SILENCE_AFTER_MIN = 30;
/** 연속 미도착 관측 최소 횟수 — 경과 아래 깔린 하한. */
export const SILENCE_MIN_OBS = 6;
/** Cron Trigger 간격(분). 이보다 짧게 지난 tick 은 미도착이 아니다. */
export const TICK_MIN = 5;

export interface BeatState {
  /** 마지막 생존 신고 시각(ms). null = 아직 한 번도 못 받음 */
  lastBeatMs: number | null;
  /** 연속 미도착 관측 횟수 */
  missStreak: number;
  /** 침묵을 이미 알렸는가(중복 발송 방지) */
  alerted: boolean;
}

export interface Notice {
  kind: "silence" | "recovered";
  /** 침묵한 시간(분) — 문구에 그대로 실린다 */
  minutes: number;
}

export interface Decision {
  next: BeatState;
  notice: Notice | null;
}

export function initialState(): BeatState {
  return { lastBeatMs: null, missStreak: 0, alerted: false };
}

/** 음수(시계 역행)는 0 으로 접는다 — 이 방향의 열화는 "늦게 알린다"이지 거짓 빨강이 아니다. */
function elapsedMin(lastBeatMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - lastBeatMs) / 60_000));
}

export function onBeat(state: BeatState, nowMs: number): Decision {
  const notice: Notice | null =
    state.alerted && state.lastBeatMs !== null
      ? { kind: "recovered", minutes: elapsedMin(state.lastBeatMs, nowMs) }
      : null;
  return { next: { lastBeatMs: nowMs, missStreak: 0, alerted: false }, notice };
}

export function onTick(state: BeatState, nowMs: number): Decision {
  // 한 번도 신고를 못 받았으면 지금을 기준점으로 잡는다. 배포 직후 맥이 아직 안 붙은
  // 상태에서 곧바로 울리면, 이 도구는 첫날부터 무시당하는 알림이 된다.
  if (state.lastBeatMs === null) {
    return { next: { ...state, lastBeatMs: nowMs }, notice: null };
  }

  const minutes = elapsedMin(state.lastBeatMs, nowMs);
  const missed = minutes >= TICK_MIN;
  const missStreak = missed ? state.missStreak + 1 : 0;
  const next: BeatState = { ...state, missStreak };

  if (!state.alerted && minutes >= SILENCE_AFTER_MIN && missStreak >= SILENCE_MIN_OBS) {
    return { next: { ...next, alerted: true }, notice: { kind: "silence", minutes } };
  }
  return { next, notice: null };
}
