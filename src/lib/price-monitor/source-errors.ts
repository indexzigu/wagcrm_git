// 시장 최저가 소스(네이버/쿠팡/카카오)의 실패를 화면이 읽을 수 있게 요약한다 — 순수함수·클라 안전.
//
// ⚠️ market-fetch.ts 는 `node:crypto` 를 쓰는 **서버 전용** 모듈이라 클라이언트 컴포넌트가
// 거기서 타입을 끌어올 수 없다. 그래서 에러 형태의 타입 정본을 이 파일에 두고 market-fetch 쪽이
// 역으로 import 한다(서버→클라안전 방향은 안전). 두 곳에 같은 형태를 따로 적으면 소스가
// 늘어날 때 조용히 갈라진다.
export type MarketSourceErrors = {
  naver?: string | null;
  coupang?: string | null;
  kakao?: string | null;
};

export type MarketSourceChannel = keyof MarketSourceErrors;

/** 화면 표기명. 채널 키를 늘리면 여기도 늘려야 타입이 통과한다(누락 방지). */
export const MARKET_SOURCE_LABEL: Record<MarketSourceChannel, string> = {
  naver: "네이버",
  coupang: "쿠팡",
  kakao: "카카오 선물하기",
};

const CHANNELS = Object.keys(MARKET_SOURCE_LABEL) as MarketSourceChannel[];

export type SourceFailureSummary = {
  /** 실패한 소스 — 표기명과 원문 사유(진단용) */
  failed: { channel: MarketSourceChannel; label: string; reason: string }[];
  /** 그래서 이번 판정이 실제로 무엇만 보고 내려졌는지 */
  includedLabels: string[];
};

/**
 * 조회된 결과들의 errors 를 하나로 합쳐 "무엇이 빠졌고 무엇만 보고 판정했는지"를 만든다.
 *
 * - 실패가 하나도 없으면 **null** 을 돌려준다 — 호출부는 이때 아무것도 렌더하지 않는다.
 *   (정상 상태에 배너가 상주하면 P8 §2대로 경고가 습관화돼 신호를 잃는다.)
 * - `null` 사유는 실패가 아니다. 쿠팡은 키 미설정 시 의도적으로 `error: null` 로 침묵하는
 *   "미도입 파킹" 계약이라(market-fetch.ts), 그 상태가 경고로 새면 계약이 깨진다.
 * - 여러 딜을 조회하면 같은 실패가 딜 수만큼 반복되므로 **채널당 1건으로 접는다**(첫 사유 채택).
 */
export function summarizeSourceFailures(
  errorsList: (MarketSourceErrors | null | undefined)[],
): SourceFailureSummary | null {
  const firstReason = new Map<MarketSourceChannel, string>();
  let observed = false;

  for (const errors of errorsList) {
    if (!errors) continue;
    observed = true;
    for (const channel of CHANNELS) {
      const reason = errors[channel];
      if (typeof reason === "string" && reason.trim() && !firstReason.has(channel)) {
        firstReason.set(channel, reason.trim());
      }
    }
  }

  // 아직 아무 딜도 조회하지 않았으면 판단할 근거 자체가 없다(빈 배너 방지).
  if (!observed || firstReason.size === 0) return null;

  return {
    failed: CHANNELS.filter((c) => firstReason.has(c)).map((channel) => ({
      channel,
      label: MARKET_SOURCE_LABEL[channel],
      reason: firstReason.get(channel)!,
    })),
    includedLabels: CHANNELS.filter((c) => !firstReason.has(c)).map((c) => MARKET_SOURCE_LABEL[c]),
  };
}
