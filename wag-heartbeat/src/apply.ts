/**
 * 상태 저장 + 발송 어댑터. Worker 런타임 타입(KVNamespace)이나 전역 fetch 에 묶이지
 * 않도록 구조적 타입으로만 의존성을 받는다 — 그래야 decide.ts 처럼 vitest 가 이
 * 파일을 직접, 목킹 없이 돌릴 수 있다.
 *
 * 핵심 불변식: **통지 상태(alerted)는 발송이 실제로 성공했을 때만 바뀐다.**
 * 발송이 실패(또는 예외)하면 이전 alerted 값을 그대로 유지해 다음 tick/beat 에서
 * 다시 시도하게 한다. lastBeatMs·missStreak 는 관측 사실이라 발송 성공 여부와
 * 무관하게 항상 저장한다.
 *
 * C2 (2026-08-19 최종 리뷰): 위 불변식대로면 중복 억제의 유일한 근거가
 * `store.put()` 의 성공이 된다 — KV 쓰기가 거부되면(무료 티어 한도 소진·일시
 * 장애·rate limit) `alerted` 가 영영 안 붙어 5분마다 같은 침묵 알림이 나간다.
 * 그래서 이 파일은 그 위에 별개 층을 더한다:
 *  ① `lastNoticeMs` — `alerted` 와 **독립적으로** 판정되는 절대 재발송 하한
 *    (`RESEND_MIN_INTERVAL_H`, 맥 `notify.sh` 와 같은 값). 발송을 시도하는
 *    순간 별도 put 으로 먼저 심어 둬서, 이후 `alerted` 를 담은 최종 put 이
 *    실패해도 다음 tick 에서 재발송을 막을 수 있게 한다.
 *  ② 쓰기 감축 — 직렬화 결과가 이전과 같으면 put 을 생략하고, beat 는 마지막
 *    저장으로부터 240초 이내면 저장을 생략한다(크래시 재기동 폭주만 접는다).
 * decide.ts 의 두 조건(경과∧연속 관측) 판정 로직 자체는 건드리지 않는다.
 */
import { onBeat, onTick, initialState, type BeatState, type Decision, type Notice } from "./decide";

/** KV 대신 주입하는 최소 저장소 인터페이스. */
export interface StateStore {
  get(): Promise<string | null>;
  put(value: string): Promise<void>;
}

/** 침묵 알림 절대 재발송 하한(시간). 맥 `infra/selfhost/notify.sh` 의
 * `RESEND_MIN_INTERVAL_H` 와 반드시 같은 값 — 두 감시 경로의 소음 예산을 맞춘다. */
export const RESEND_MIN_INTERVAL_H = 6;
const RESEND_MIN_INTERVAL_MS = RESEND_MIN_INTERVAL_H * 60 * 60 * 1000;

/** 연속 beat 간격이 이보다 짧으면 저장을 생략한다. 정상 full 폴링(300초)은 항상
 * 이 값을 넘으므로 매번 기록되고, 크래시 루프의 재기동 폭주만 접힌다. */
export const BEAT_SAVE_DEBOUNCE_MS = 240_000;

/** KV 에 실제로 저장하는 형태 — `decide.ts` 의 판정에는 관여하지 않는 재발송 하한
 * 필드(`lastNoticeMs`)를 얹는다. `BeatState` 의 상위집합이라 decide.ts 의 함수들에
 * 구조적으로 그대로 넘길 수 있다. */
export interface StoredState extends BeatState {
  /** 마지막으로 침묵 알림을 발송 시도한 시각(ms). `alerted` 와 별개로 저장돼,
   * `alerted` 를 담은 put 이 실패해도 재발송을 막는 하한으로 쓰인다. */
  lastNoticeMs: number | null;
}

function initialStoredState(): StoredState {
  return { ...initialState(), lastNoticeMs: null };
}

/** 항상 같은 키 순서로 직렬화한다 — 순서가 흔들리면 "직렬화 결과가 같으면 put
 * 생략" 비교가 값은 같은데 문자열만 달라 오탐(불필요한 쓰기)할 수 있다. */
function serialize(s: StoredState): string {
  return JSON.stringify({
    lastBeatMs: s.lastBeatMs,
    missStreak: s.missStreak,
    alerted: s.alerted,
    lastNoticeMs: s.lastNoticeMs,
  });
}

/** 직렬화 결과가 이전과 같으면 put 을 생략한다(쓰기 감축 ①). */
async function putIfChanged(store: StateStore, prev: StoredState, next: StoredState): Promise<void> {
  if (serialize(prev) === serialize(next)) return;
  await store.put(serialize(next));
}

function withinResendFloor(state: StoredState, nowMs: number): boolean {
  return state.lastNoticeMs !== null && nowMs - state.lastNoticeMs < RESEND_MIN_INTERVAL_MS;
}

/** 텔레그램 대신 주입하는 발송기. 성공하면 true, 실패(예외 포함)해도 이 함수 자체는
 * 절대 throw 하지 않아야 한다 — 호출부(applyDecision)가 다시 한 번 감싸긴 하지만,
 * 발송기 구현 쪽에서도 삼키는 것이 원칙이다(방어 이중화). */
export type Sender = (text: string) => Promise<boolean>;

/** 손상된 JSON 은 리셋한다 — 알림이 늦어질 뿐 거짓 빨강은 나지 않는다. 기존(3필드)
 * 형식으로 저장된 상태를 읽어도 `lastNoticeMs` 는 안전하게 null 로 채워진다 —
 * 이 필드를 새로 얹은 배포 직후에도 마이그레이션 없이 그대로 동작한다. */
export function parseState(raw: string | null): StoredState {
  if (!raw) return initialStoredState();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      lastBeatMs: typeof parsed.lastBeatMs === "number" ? parsed.lastBeatMs : null,
      missStreak: typeof parsed.missStreak === "number" ? parsed.missStreak : 0,
      alerted: parsed.alerted === true,
      lastNoticeMs: typeof parsed.lastNoticeMs === "number" ? parsed.lastNoticeMs : null,
    };
  } catch {
    return initialStoredState();
  }
}

export async function loadState(store: StateStore): Promise<StoredState> {
  return parseState(await store.get());
}

/** 봇 이름("WAG 서버")이 알림 앞에 이미 붙으므로 본문에 서비스명을 다시 넣지 않는다. */
export function noticeText(notice: Notice): string {
  return notice.kind === "silence"
    ? `⚫ 응답 없음 — ${notice.minutes}분째 생존 신호가 오지 않습니다. 맥 또는 메뉴바 앱이 멈췄을 수 있습니다.`
    : `✅ 생존 신호 복구 — ${notice.minutes}분 만에 돌아왔습니다.`;
}

/**
 * decide.ts 의 판정을 저장·발송에 반영한다.
 *
 * notice 가 없으면 발송할 것이 없으니 next 를 그대로 저장한다(단, `lastNoticeMs`
 * 는 이 판정과 무관하므로 이전 값을 그대로 이어간다). notice 가 있으면:
 *
 *  - `recovered`: 지금까지와 동일하게 발송을 시도하고, 성공했을 때만 next(=
 *    alerted 가 갱신된 값)를 저장한다. 실패하면 alerted 를 이전 state 값으로
 *    되돌려 다음 회차 재시도를 보장한다(기존 규약, 변경 없음). 재발송 하한
 *    **검사**는 `silence` 전용이라 여기서는 관여하지 않는다 — "하한이 복구
 *    통지를 막지 않는다"는 이 설계의 명시 요구다. 다만 복구가 실제로
 *    확인되면(발송 성공) `lastNoticeMs` 도 함께 지운다 — 맥 `notify.sh` 의
 *    "회복 시 ②의 기록은 지운다" 규약과 같다. 안 지우면 "복구 → (별개의)
 *    새 침묵이 6시간 안에 재발"하는 경우 그 새 침묵이 옛 알림 시각에 걸려
 *    조용히 묵살된다 — alerted 는 매번 리셋되는데 lastNoticeMs 만 안 지워지면
 *    두 필드가 서로 다른 인시던트를 가리키게 된다.
 *  - `silence`: 먼저 절대 재발송 하한(`RESEND_MIN_INTERVAL_H`)을 본다. 하한
 *    안이면 발송하지 않고 alerted 도 이전 값으로 유지한다(하한이 풀리면 다시
 *    평가되도록). 하한 밖이면 **발송을 시도하기 전에** `lastNoticeMs=now` 를
 *    먼저 심어 둔다(별도 put, 실패해도 무시하고 계속 진행) — 그래야 뒤이은
 *    발송·최종 저장이 같은 KV 장애로 실패해도 이 클레임만은 남아 다음 tick 의
 *    하한을 무장시킬 수 있다. `alerted` 를 담은 put 성공 여부에 재발송 억제를
 *    전적으로 의존하던 기존 구조의 단일 실패점을 없애는 것이 이 층의 목적이다.
 *
 * 모든 저장은 `putIfChanged` 를 거친다 — 직렬화 결과가 이전과 같으면 쓰기 자체를
 * 생략해 무료 티어 쓰기 한도를 아낀다.
 */
export async function applyDecision(
  store: StateStore,
  send: Sender,
  state: StoredState,
  decision: Decision,
  nowMs: number,
): Promise<void> {
  const { next, notice } = decision;

  if (!notice) {
    await putIfChanged(store, state, { ...next, lastNoticeMs: state.lastNoticeMs });
    return;
  }

  if (notice.kind === "silence") {
    if (withinResendFloor(state, nowMs)) {
      // 절대 하한에 걸림 — 재발송하지 않는다. alerted 는 이전 값 그대로 둬서
      // 하한이 풀린 뒤에도 decide.ts 가 다시 판정할 수 있게 한다.
      await putIfChanged(store, state, { ...next, alerted: state.alerted, lastNoticeMs: state.lastNoticeMs });
      return;
    }
    try {
      await store.put(serialize({ ...state, lastNoticeMs: nowMs }));
    } catch {
      // 클레임 저장 실패는 무시한다 — 발송 자체는 계속 시도한다. 아래 최종 put 이
      // 성공하면 어차피 같은 값이 다시 저장된다.
    }
  }

  let sent: boolean;
  try {
    sent = await send(noticeText(notice));
  } catch {
    sent = false;
  }
  const alertedToSave = sent ? next.alerted : state.alerted;
  // silence: 발송 시도 자체를 하한 기준으로 남긴다(성공 여부 무관, 위 설명 참조).
  // recovered: 발송이 실제로 성공했을 때만 지운다 — 실패하면 "복구 미확인" 그대로다.
  const lastNoticeMsToSave =
    notice.kind === "silence" ? nowMs : sent ? null : state.lastNoticeMs;
  await putIfChanged(store, state, { ...next, alerted: alertedToSave, lastNoticeMs: lastNoticeMsToSave });
}

export async function handleBeat(store: StateStore, send: Sender, nowMs: number): Promise<void> {
  const state = await loadState(store);
  const decision = onBeat(state, nowMs);
  // 쓰기 감축 ② — 신고 자체가 통지를 유발하지 않는 한(즉 복구 통지가 없는 한),
  // 마지막 저장으로부터 240초를 못 채운 beat 는 저장을 생략한다. 정상 full 폴링
  // (300초)은 항상 이 값을 넘으므로 매번 그대로 기록되고, 크래시 재기동 폭주만
  // 접힌다. 복구 통지가 걸린 beat 는 절대 생략하지 않는다.
  if (!decision.notice && state.lastBeatMs !== null && nowMs - state.lastBeatMs < BEAT_SAVE_DEBOUNCE_MS) {
    return;
  }
  await applyDecision(store, send, state, decision, nowMs);
}

export async function handleTick(store: StateStore, send: Sender, nowMs: number): Promise<void> {
  const state = await loadState(store);
  await applyDecision(store, send, state, onTick(state, nowMs), nowMs);
}
