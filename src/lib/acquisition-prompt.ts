/**
 * 캠페인 생성·영업 전환 시점에 「유입 경로」를 물을지 판정하는 단일 술어.
 * 두 진입점(캠페인 생성 폼, 영업 전환)이 이 함수를 같이 쓴다 — 사본을 만들지 말 것.
 * 빈 값(null·undefined·빈 문자열)만 묻는다. 이미 값이 있으면 다시 묻지 않는다.
 */
export function needsAcquisitionPrompt(
  seller: { acquisitionChannel?: string | null } | null | undefined,
): boolean {
  if (!seller) return false;
  const channel = seller.acquisitionChannel;
  return channel === null || channel === undefined || channel === "";
}
