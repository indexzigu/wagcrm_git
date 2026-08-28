import type { BaseMarginPolicy, SalesChannel } from "./crm-types";

export type ComputedMargins = {
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
};

/**
 * 딜의 마진 정책에서 채널에 해당하는 수수료율을 추출한다.
 * 매칭되는 채널이 없으면 null을 반환한다.
 */
export function getMarginRatesFromPolicy(
  policy: BaseMarginPolicy,
  channel: SalesChannel
): ComputedMargins | null {
  const channelRate = policy.byChannel[channel];
  if (!channelRate) return null;
  return {
    totalMarginRate: channelRate.totalMarginRate,
    sellerMarginRate: channelRate.sellerMarginRate,
    netMarginRate: channelRate.totalMarginRate - channelRate.sellerMarginRate,
  };
}

/**
 * DB에 저장된 JSON 문자열을 BaseMarginPolicy 객체로 파싱한다.
 * 파싱 실패 시 null을 반환한다.
 */
export function parseMarginPolicy(policyJson: string): BaseMarginPolicy | null {
  try {
    return JSON.parse(policyJson) as BaseMarginPolicy;
  } catch {
    return null;
  }
}
