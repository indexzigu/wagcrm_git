/**
 * 정산 금액 수정 자동 실행기 설정 — 환경변수를 **매 회차** 읽는다(모듈 상수로 캡처하면 기동 뒤
 * 바꾼 스위치·킬스위치가 반영되지 않는다 — `isAutoApprovable` 과 같은 이유).
 *
 * 설계 정본: Hermes `docs/wag-bridge-phase2-plan.md` §3·§4·§5 B(오너 승인 2026-10-09).
 *
 * ## 스위치
 * - `AGENT_AUTO_EXECUTE` = `off`(미설정 기본) | `shadow` | `on`. 그 밖의 값은 **off** 로 본다
 *   (오타가 실행을 여는 일이 없게 — fail-closed).
 * - `AUTO_APPROVE_DISABLED` 가 **값과 무관하게** 존재하면 off(기존 긴급 잠금과 같은 의미론).
 *
 * ## 대조 기준(슬랙 원문)
 * 채널·Muse 봇 3중 신원은 **환경변수로만** 받는다 — 소스에 기본값을 두지 않는다. 하나라도
 * 비면 판정은 `not_configured`(보류)이고 아무것도 실행하지 않는다.
 *
 * ## 한도
 * 숫자가 아닌 값(쉼표·음수 등)은 기본값으로 대체하지 않고 `not_configured` 로 막는다 —
 * "100,000" 처럼 **더 좁히려던** 오타가 기본값(더 넓음)으로 조용히 바뀌면 안 된다.
 */

export type AutoExecuteMode = "off" | "shadow" | "on";

export const DEFAULT_MAX_ABS_DELTA_KRW = 500_000;
export const DEFAULT_MAX_PER_DAY = 10;
export const DEFAULT_MESSAGE_WINDOW_MINUTES = 60;

export type AutoExecuteConfig = {
  mode: AutoExecuteMode;
  /** 슬랙 읽기 토큰. 값은 어디에도 기록·출력하지 않는다. */
  slackToken: string | null;
  channelId: string | null;
  museBotId: string | null;
  museAppId: string | null;
  museUserId: string | null;
  /** 숫자 해석 실패면 null — 판정이 `not_configured` 로 막는다. */
  maxAbsDeltaKrw: number | null;
  maxPerDay: number | null;
  messageWindowMinutes: number | null;
};

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** 미설정이면 기본값, 설정했는데 0 이상 정수가 아니면 null(차단). */
function readNonNegativeInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number | null {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function resolveAutoExecuteMode(env: NodeJS.ProcessEnv = process.env): AutoExecuteMode {
  // 긴급 잠금 — 값과 무관하게 존재하면 off("0"/"false" 도 잠금). 해제는 변수 삭제.
  if (env.AUTO_APPROVE_DISABLED !== undefined) return "off";
  const raw = env.AGENT_AUTO_EXECUTE?.trim().toLowerCase();
  if (raw === "shadow" || raw === "on") return raw;
  return "off";
}

export function readAutoExecuteConfig(env: NodeJS.ProcessEnv = process.env): AutoExecuteConfig {
  return {
    mode: resolveAutoExecuteMode(env),
    slackToken: readTrimmed(env, "SLACK_BRIDGE_READ_TOKEN"),
    channelId: readTrimmed(env, "AGENT_AUTO_EXECUTE_CHANNEL_ID"),
    museBotId: readTrimmed(env, "AGENT_AUTO_EXECUTE_MUSE_BOT_ID"),
    museAppId: readTrimmed(env, "AGENT_AUTO_EXECUTE_MUSE_APP_ID"),
    museUserId: readTrimmed(env, "AGENT_AUTO_EXECUTE_MUSE_USER_ID"),
    maxAbsDeltaKrw: readNonNegativeInt(env, "AGENT_AUTO_EXECUTE_MAX_ABS_DELTA_KRW", DEFAULT_MAX_ABS_DELTA_KRW),
    maxPerDay: readNonNegativeInt(env, "AGENT_AUTO_EXECUTE_MAX_PER_DAY", DEFAULT_MAX_PER_DAY),
    messageWindowMinutes: readNonNegativeInt(
      env,
      "AGENT_AUTO_EXECUTE_MESSAGE_WINDOW_MINUTES",
      DEFAULT_MESSAGE_WINDOW_MINUTES,
    ),
  };
}

/** 설정에서 빠진 항목의 **이름**(값이 아니다). 비어 있으면 대조를 시작할 수 있다. */
export function missingVerificationSettings(config: AutoExecuteConfig): string[] {
  const missing: string[] = [];
  if (!config.channelId) missing.push("AGENT_AUTO_EXECUTE_CHANNEL_ID");
  if (!config.museBotId) missing.push("AGENT_AUTO_EXECUTE_MUSE_BOT_ID");
  if (!config.museAppId) missing.push("AGENT_AUTO_EXECUTE_MUSE_APP_ID");
  if (!config.museUserId) missing.push("AGENT_AUTO_EXECUTE_MUSE_USER_ID");
  if (config.maxAbsDeltaKrw === null) missing.push("AGENT_AUTO_EXECUTE_MAX_ABS_DELTA_KRW");
  if (config.maxPerDay === null) missing.push("AGENT_AUTO_EXECUTE_MAX_PER_DAY");
  if (config.messageWindowMinutes === null) missing.push("AGENT_AUTO_EXECUTE_MESSAGE_WINDOW_MINUTES");
  return missing;
}
