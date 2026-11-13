export type MarketSourceStatus = "ok" | "empty" | "error" | "disabled";

export type MarketSourceState = {
  status: MarketSourceStatus;
  checkedAt: string;
  itemCount: number;
};

export type MarketSourceStates = Record<"naver" | "coupang" | "kakao", MarketSourceState>;

export function createMarketSourceState(
  status: MarketSourceStatus,
  itemCount: number,
  checkedAt = new Date().toISOString(),
): MarketSourceState {
  return { status, checkedAt, itemCount };
}
