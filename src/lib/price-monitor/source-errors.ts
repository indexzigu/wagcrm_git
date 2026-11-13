// 시장 최저가 소스(네이버/쿠팡/카카오)의 실패를 화면이 읽을 수 있게 요약한다 — 순수함수·클라 안전.
// source 상태 타입은 서버 전용 market-fetch와 클라이언트 소비처가 함께 쓰는 source-status.ts를
// 정본으로 삼는다. 이 파일에는 화면용 오류·요약 타입만 둔다.
export type MarketSourceErrors = {
  naver?: string | null;
  coupang?: string | null;
  kakao?: string | null;
};

export type MarketSourceChannel = keyof MarketSourceErrors;

export type { MarketSourceState, MarketSourceStates, MarketSourceStatus } from "./source-status";
import type { MarketSourceState, MarketSourceStates, MarketSourceStatus } from "./source-status";

export type SourceFailureObservation = {
  errors?: MarketSourceErrors | null;
  sources?: MarketSourceStates | null;
};

/** 화면 표기명. 채널 키를 늘리면 여기도 늘려야 타입이 통과한다(누락 방지). */
export const MARKET_SOURCE_LABEL: Record<MarketSourceChannel, string> = {
  naver: "네이버",
  coupang: "쿠팡",
  kakao: "카카오 선물하기",
};

const CHANNELS = Object.keys(MARKET_SOURCE_LABEL) as MarketSourceChannel[];
const SOURCE_STATUSES = new Set<MarketSourceStatus>(["ok", "empty", "error", "disabled"]);
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type SourceFailureSummary = {
  /** 실패한 소스 — 표기명과 원문 사유(진단용) */
  failed: { channel: MarketSourceChannel; label: string; reason: string }[];
  /** 의도적으로 연결하지 않은 소스 — 정상/성공 근거로 표시하면 안 된다. */
  disabled: { channel: MarketSourceChannel; label: string }[];
  /** 그래서 이번 판정이 실제로 무엇만 보고 내려졌는지 */
  includedLabels: string[];
  /** sources가 없는 legacy 결과. 성공한 소스를 추정하지 않는다. */
  unknown: boolean;
  /** 최신 조회 상태와 조회시각 — 모달이 상태를 보존해서 보여줄 때 사용한다. */
  statuses: Array<{
    channel: MarketSourceChannel;
    label: string;
    status: MarketSourceStatus;
    checkedAt: string;
    itemCount: number;
  }>;
};

export type SourceStatusSummary = Pick<SourceFailureSummary, "statuses" | "unknown">;

type SourceFailureInput =
  | MarketSourceErrors
  | SourceFailureObservation
  | null
  | undefined;

function isObservation(input: SourceFailureInput): input is SourceFailureObservation {
  return Boolean(input && ("errors" in input || "sources" in input));
}

function normalizeObservations(inputs: SourceFailureInput[]): SourceFailureObservation[] {
  return inputs.map((input) => {
    if (isObservation(input)) return input;
    return { errors: input };
  });
}

function checkedAtValue(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return parsed;
}

function isMarketSourceState(value: unknown): value is MarketSourceState {
  if (value == null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.checkedAt === "string" &&
    checkedAtValue(state.checkedAt) !== null &&
    SOURCE_STATUSES.has(state.status as MarketSourceStatus) &&
    typeof state.itemCount === "number" &&
    Number.isFinite(state.itemCount) &&
    state.itemCount >= 0
  );
}

function collectSourceStatuses(
  observations: SourceFailureObservation[],
): { observed: boolean; hasStates: boolean; hasUnknown: boolean; latestStates: Map<MarketSourceChannel, MarketSourceState> } {
  const latestStates = new Map<MarketSourceChannel, MarketSourceState>();
  let observed = false;
  let hasUnknown = false;

  for (const observation of observations) {
    if (!observation.errors && !observation.sources) continue;
    observed = true;
    if (!observation.sources) {
      hasUnknown = true;
      continue;
    }
    let hasCompleteStates = true;
    for (const channel of CHANNELS) {
      const state = observation.sources[channel];
      if (!isMarketSourceState(state)) {
        hasCompleteStates = false;
        continue;
      }
      const previous = latestStates.get(channel);
      const stateTime = checkedAtValue(state.checkedAt);
      const previousTime = previous ? checkedAtValue(previous.checkedAt) : null;
      if (stateTime !== null && (previousTime === null || stateTime >= previousTime)) {
        latestStates.set(channel, state);
      }
    }
    if (!hasCompleteStates) hasUnknown = true;
  }

  return { observed, hasStates: latestStates.size > 0, hasUnknown, latestStates };
}

function toStatusSummary(
  observations: SourceFailureObservation[],
): SourceStatusSummary & { observed: boolean; hasStates: boolean } {
  const { observed, hasStates, hasUnknown, latestStates } = collectSourceStatuses(observations);
  return {
    observed,
    hasStates,
    unknown: observed && hasUnknown,
    statuses: CHANNELS.flatMap((channel) => {
      const state = latestStates.get(channel);
      return state
        ? [{ channel, label: MARKET_SOURCE_LABEL[channel], ...state }]
        : [];
    }),
  };
}

/** 여러 조회 결과에서 최신 소스 상태를 모은다. sources가 없으면 unknown으로만 남긴다. */
export function summarizeSourceStatuses(
  inputs: SourceFailureInput[],
): SourceStatusSummary | null {
  const summary = toStatusSummary(normalizeObservations(inputs));
  if (!summary.observed) return null;
  return { statuses: summary.statuses, unknown: summary.unknown };
}

/**
 * 조회된 결과의 errors와 sources를 하나로 합쳐 "무엇이 빠졌고 무엇만 보고 판정했는지"를 만든다.
 *
 * - 실패가 하나도 없으면 **null** 을 돌려준다 — 호출부는 이때 아무것도 렌더하지 않는다.
 *   (정상 상태에 배너가 상주하면 P8 §2대로 경고가 습관화돼 신호를 잃는다.)
 * - `null` 사유는 실패가 아니다. 쿠팡은 키 미설정 시 의도적으로 `error: null` 로 침묵하는
 *   "미도입 파킹" 계약이라(market-fetch.ts), 그 상태가 경고로 새면 계약이 깨진다.
 * - 여러 딜을 조회하면 같은 실패가 딜 수만큼 반복되므로 **채널당 1건으로 접는다**(첫 사유 채택).
 * - sources가 없는 legacy 결과는 성공 소스를 추정하지 않고 unknown으로 돌려준다.
 */
export function summarizeSourceFailures(
  inputs: SourceFailureInput[],
): SourceFailureSummary | null {
  const observations = normalizeObservations(inputs);
  const statusSummary = toStatusSummary(observations);
  const firstReason = new Map<MarketSourceChannel, string>();

  for (const observation of observations) {
    const errors = observation.errors;
    if (!errors) continue;
    for (const channel of CHANNELS) {
      const reason = errors[channel];
      if (typeof reason === "string" && reason.trim() && !firstReason.has(channel)) {
        firstReason.set(channel, reason.trim());
      }
    }
  }

  for (const channel of CHANNELS) {
    const state = statusSummary.statuses.find((entry) => entry.channel === channel);
    if (state?.status === "error" && !firstReason.has(channel)) {
      firstReason.set(channel, "소스 응답 실패");
    }
  }

  const failed = CHANNELS.filter((channel) => firstReason.has(channel)).map((channel) => ({
    channel,
    label: MARKET_SOURCE_LABEL[channel],
    reason: firstReason.get(channel)!,
  }));
  const disabled = statusSummary.statuses
    .filter((entry) => entry.status === "disabled")
    .map(({ channel, label }) => ({ channel, label }));
  const includedLabels = statusSummary.statuses
    .filter(
      (entry) =>
        !statusSummary.unknown &&
        (entry.status === "ok" || entry.status === "empty") &&
        !firstReason.has(entry.channel) &&
        !disabled.some((item) => item.channel === entry.channel),
    )
    .map((entry) => entry.label);

  // 아직 아무 딜도 조회하지 않았으면 판단할 근거 자체가 없다(빈 배너 방지).
  if (!statusSummary.observed) return null;
  if (failed.length === 0 && disabled.length === 0 && !statusSummary.unknown) return null;

  return {
    failed,
    disabled,
    includedLabels,
    unknown: statusSummary.unknown,
    statuses: statusSummary.statuses,
  };
}
