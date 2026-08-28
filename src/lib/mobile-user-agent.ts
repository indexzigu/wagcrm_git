/**
 * UA 기반 모바일 판정의 서버·클라이언트 공용 정본.
 *
 * 클라이언트 분기(`useIsMobile`, src/hooks/use-mobile.ts)와 반드시 같은 집합을
 * 판정해야 한다 — /pipeline 서버 렌더가 이 판정으로 모바일 경량 데이터
 * (`getDashboardData({ scope: "mobileLite" })`)를 고르기 때문에, 서버는
 * 모바일로 봤는데 클라이언트가 데스크톱 뷰를 그리면 데스크톱 UI가 빈
 * 마스터데이터(딜·셀러 픽커)를 받는 사고가 된다. 정규식을 바꿀 때는 양쪽이
 * 이 상수 하나를 공유하는 구조를 유지할 것.
 */
export const MOBILE_USER_AGENT_REGEX =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

export function isMobileUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return MOBILE_USER_AGENT_REGEX.test(userAgent);
}
